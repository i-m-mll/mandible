import type { ManagedQuestion } from "./types.js";

export function managedQuestions(input: unknown): ManagedQuestion[] | undefined {
  if (!input || typeof input !== "object" || !Array.isArray((input as { questions?: unknown }).questions)) return undefined;
  const questions = (input as { questions: unknown[] }).questions;
  if (!questions.length) return undefined;
  const result: ManagedQuestion[] = [];
  for (const value of questions) {
    if (!value || typeof value !== "object") return undefined;
    const question = value as Record<string, unknown>;
    if (typeof question.question !== "string" || (question.options !== null && !Array.isArray(question.options))) return undefined;
    const options: ManagedQuestion["options"] = [];
    for (const value of question.options ?? []) {
      if (!value || typeof value !== "object" || typeof (value as { label?: unknown }).label !== "string") return undefined;
      const option = value as { label: string; description?: unknown };
      options.push({ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) });
    }
    result.push({ id: typeof question.id === "string" ? question.id : question.question,
      title: typeof question.header === "string" ? question.header : question.question,
      question: question.question, options, multi_select: question.multiSelect === true,
      allow_other: question.isOther !== false || options.length === 0, secret: question.isSecret === true });
  }
  return new Set(result.map(question => question.id)).size === result.length ? result : undefined;
}

export function validQuestionAnswers(questions: ManagedQuestion[], answers: unknown): answers is Record<string, string[]> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  const record = answers as Record<string, unknown>;
  return Object.keys(record).length === questions.length && questions.every(question => {
    const values = record[question.id];
    return Array.isArray(values) && values.length > 0 && (question.multi_select || values.length === 1)
      && values.every(value => typeof value === "string" && value.trim().length > 0 && (question.allow_other || question.options.some(option => option.label === value)));
  });
}
