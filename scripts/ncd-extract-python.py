#!/usr/bin/env python3
"""Python unit extraction and alpha-normalization for scripts/ncd-scan.mjs.

The scanner's prefilter, NCD scoring and reporting stages are language-agnostic:
they consume an array of string tokens and a path. Only extraction is bound to a
language. This module is the Python half of that seam. It is invoked once per
scan as a batch subprocess by the Node scanner, never on its own.

Protocol
--------
stdin   {"sources": [{"path": "rel/path.py", "text": "..."}, ...],
         "literals": "erase" | "keep",
         "kinds": ["function", "class", "sql"]}
stdout  {"units": [...], "errors": [{"path": ..., "message": ...}]}

Each unit is {path, kind, name, start, end, startLine, endLine, tokens}.
`start`/`end` are UTF-8 byte offsets, used only for same-file containment
comparison, so any consistent unit works. Units of kind "sql" carry `raw`
instead of `tokens`: the Node side normalizes them with the one SQL normalizer
that already exists there, rather than growing a second one here.

Normalization contract, mirroring the TypeScript extractor
----------------------------------------------------------
Preserved: node kinds (so control flow, comprehension shape and operator
structure survive), and free identifiers -- call targets, imported names,
attribute names, keyword-argument names, class field names. Those are the
external contract a unit participates in, not a locally arbitrary choice.

Alpha-renamed to $0, $1, ... in order of first appearance: names bound inside
the unit -- parameters, assignment and augmented-assignment targets, walrus
targets, for and comprehension targets, `with ... as`, `except ... as`, nested
function and class names, and the unit's own name.

Deliberately NOT bound: import aliases. `import numpy as np` leaves `np` free,
so `np.linalg.solve` and `jnp.linalg.solve` remain distinguishable. Class-body
field names are likewise left free, because a dataclass or equinox.Module field
name is part of that class's contract the way a TypeScript property declaration
name is.

Erased by default: string, bytes and numeric literal payloads (`#s`, `#n`).
`None`, `True`, `False` and `...` are kept, matching the TypeScript extractor's
treatment of `null`, `true` and `false` as keyword tokens.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from typing import Any

# A string literal is offered to the Node SQL normalizer only if it is long
# enough to be a statement and contains a statement keyword. Mirrors SQL_RE in
# scripts/ncd-scan.mjs.
SQL_RE = re.compile(
    r"\b(CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)|SELECT\s|INSERT\s+INTO"
    r"|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE)\b",
    re.IGNORECASE,
)
SQL_MIN_CHARS = 120

FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def contract_names(tree: ast.AST) -> tuple[set[int], set[int]]:
    """Nodes whose names belong to a class's external contract, not to a local.

    Two sets of node ids are returned: Name nodes that are class-body field
    targets, and def/class nodes that are direct members of a class body. A
    field name and a method name are what callers write -- `obj.hidden_size`,
    `obj.step()` -- exactly as a TypeScript property or method declaration name
    is. The TypeScript extractor keeps both verbatim; so does this one.

    Membership is by node identity, but the bound-name set downstream is by
    string, so a local variable that happens to share a method's name in the
    same class is left free too. That imprecision is present in the TypeScript
    extractor for the same reason and is bounded: it can only make two units
    look less alike, never more.
    """
    field_ids: set[int] = set()
    member_ids: set[int] = set()
    for sub in ast.walk(tree):
        if not isinstance(sub, ast.ClassDef):
            continue
        for stmt in sub.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                field_ids.add(id(stmt.target))
            elif isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    for leaf in ast.walk(target):
                        if isinstance(leaf, ast.Name):
                            field_ids.add(id(leaf))
            elif isinstance(stmt, SCOPE_NODES):
                member_ids.add(id(stmt))
    return field_ids, member_ids


def collect_bound_names(root: ast.AST, field_ids: set[int], member_ids: set[int]) -> set[str]:
    """Names bound inside a unit, so they can be alpha-renamed."""
    bound: set[str] = set()
    if isinstance(root, SCOPE_NODES) and id(root) not in member_ids:
        bound.add(root.name)
    for node in ast.walk(root):
        if isinstance(node, ast.arg):
            bound.add(node.arg)
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)) and id(node) not in field_ids:
                bound.add(node.id)
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                bound.add(node.name)
        elif isinstance(node, SCOPE_NODES) and node is not root and id(node) not in member_ids:
            bound.add(node.name)
    return bound


class Normalizer:
    """Serializes one unit as an alpha-normalized preorder token stream."""

    def __init__(self, bound: set[str], free_ids: set[int], erase_literals: bool):
        self.bound = bound
        self.free_ids = free_ids
        self.erase = erase_literals
        self.slots: dict[str, int] = {}
        self.tokens: list[str] = []

    def emit_name(self, text: str, *, free: bool = False) -> None:
        if free or text not in self.bound:
            self.tokens.append(text)
            return
        slot = self.slots.get(text)
        if slot is None:
            slot = len(self.slots)
            self.slots[text] = slot
        self.tokens.append(f"${slot}")

    def emit_constant(self, value: Any) -> None:
        if value is None or value is True or value is False:
            self.tokens.append(repr(value))
        elif value is Ellipsis:
            self.tokens.append("...")
        elif isinstance(value, (str, bytes)):
            self.tokens.append("#s" if self.erase else json.dumps(str(value)))
        elif isinstance(value, (int, float, complex)):
            self.tokens.append("#n" if self.erase else str(value))
        else:
            self.tokens.append("#c")

    def walk(self, node: ast.AST) -> None:
        # Load/Store/Del carry no information the parent statement kind does not
        # already carry, and would add one token per name reference.
        if isinstance(node, ast.expr_context):
            return

        if isinstance(node, ast.Name):
            self.emit_name(node.id, free=id(node) in self.free_ids)
            return

        if isinstance(node, ast.Constant):
            self.emit_constant(node.value)
            return

        self.tokens.append(type(node).__name__)

        if isinstance(node, ast.Attribute):
            self.walk(node.value)
            self.tokens.append(node.attr)  # attribute names are contract
            return

        if isinstance(node, ast.keyword):
            self.tokens.append(node.arg if node.arg is not None else "**")
            self.walk(node.value)
            return

        if isinstance(node, ast.arg):
            self.emit_name(node.arg)
            if node.annotation is not None:
                self.walk(node.annotation)
            return

        if isinstance(node, ast.alias):
            # Import targets stay free: which module a unit reaches for is the
            # most load-bearing free identifier it has.
            self.tokens.append(node.name)
            if node.asname:
                self.tokens.append(node.asname)
            return

        if isinstance(node, ast.ImportFrom):
            self.tokens.append(node.module or ".")
            for child in node.names:
                self.walk(child)
            return

        if isinstance(node, ast.ExceptHandler):
            if node.name:
                self.emit_name(node.name)
            for child in ast.iter_child_nodes(node):
                self.walk(child)
            return

        if isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                self.emit_name(name)
            return

        if isinstance(node, SCOPE_NODES):
            self.emit_name(node.name, free=id(node) in self.free_ids)
            for child in ast.iter_child_nodes(node):
                self.walk(child)
            return

        for child in ast.iter_child_nodes(node):
            self.walk(child)


def line_starts(data: bytes) -> list[int]:
    starts = [0]
    for i, byte in enumerate(data):
        if byte == 0x0A:
            starts.append(i + 1)
    return starts


def offset_of(starts: list[int], lineno: int, col: int) -> int:
    idx = lineno - 1
    if idx < 0 or idx >= len(starts):
        return 0
    return starts[idx] + col


def unit_start_line(node: ast.AST) -> int:
    """Decorators belong to the unit and are in its token stream, so report
    from the first decorator rather than from `def`."""
    decorators = getattr(node, "decorator_list", None) or []
    lines = [node.lineno] + [d.lineno for d in decorators if hasattr(d, "lineno")]
    return min(lines)


def extract(path: str, text: str, kinds: set[str], erase: bool) -> list[dict[str, Any]]:
    tree = ast.parse(text, filename=path)
    data = text.encode("utf-8")
    starts = line_starts(data)
    units: list[dict[str, Any]] = []

    field_ids, member_ids = contract_names(tree)
    free_ids = field_ids | member_ids

    def push(node: ast.AST, kind: str, name: str) -> None:
        bound = collect_bound_names(node, field_ids, member_ids)
        norm = Normalizer(bound, free_ids, erase)
        norm.walk(node)
        end_line = getattr(node, "end_lineno", node.lineno) or node.lineno
        end_col = getattr(node, "end_col_offset", 0) or 0
        units.append({
            "path": path,
            "kind": kind,
            "name": name,
            "start": offset_of(starts, node.lineno, node.col_offset),
            "end": offset_of(starts, end_line, end_col),
            "startLine": unit_start_line(node),
            "endLine": end_line,
            "tokens": norm.tokens,
        })

    for node in ast.walk(tree):
        if "function" in kinds and isinstance(node, FUNCTION_NODES):
            push(node, "function", node.name)
        elif "function" in kinds and isinstance(node, ast.Lambda):
            push(node, "function", "<lambda>")
        elif "class" in kinds and isinstance(node, ast.ClassDef):
            push(node, "class", node.name)
        elif "sql" in kinds and isinstance(node, ast.Constant) and isinstance(node.value, str):
            raw = node.value
            if len(raw) > SQL_MIN_CHARS and SQL_RE.search(raw):
                end_line = getattr(node, "end_lineno", node.lineno) or node.lineno
                units.append({
                    "path": path,
                    "kind": "sql",
                    "name": "sql",
                    "start": offset_of(starts, node.lineno, node.col_offset),
                    "end": offset_of(starts, end_line, getattr(node, "end_col_offset", 0) or 0),
                    "startLine": node.lineno,
                    "endLine": end_line,
                    "raw": raw,
                })

    return units


def main() -> int:
    request = json.load(sys.stdin)
    kinds = set(request.get("kinds") or ["function", "class", "sql"])
    erase = request.get("literals", "erase") == "erase"

    units: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for source in request.get("sources") or []:
        path = source["path"]
        try:
            units.extend(extract(path, source["text"], kinds, erase))
        except SyntaxError as err:
            errors.append({"path": path, "message": f"syntax error: {err}"})
        except RecursionError as err:
            errors.append({"path": path, "message": f"recursion limit: {err}"})

    json.dump({"units": units, "errors": errors}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.setrecursionlimit(20000)
    raise SystemExit(main())
