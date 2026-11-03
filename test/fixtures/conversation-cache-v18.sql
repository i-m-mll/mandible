      CREATE TABLE IF NOT EXISTS cache_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cache_conversations (
        cache_id               INTEGER PRIMARY KEY,
        conversation_id        TEXT NOT NULL,
        source_version_id      TEXT NOT NULL,
        parser_format          TEXT NOT NULL,
        parser_version         TEXT NOT NULL,
        normalization_version  TEXT NOT NULL,
        redaction_epoch        INTEGER NOT NULL,
        block_count            INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL,
        accessed_at            INTEGER NOT NULL,
        UNIQUE (conversation_id, source_version_id, parser_format, parser_version, normalization_version, redaction_epoch)
      );
      CREATE TABLE IF NOT EXISTS cache_blocks (
        cache_conversation_id  INTEGER NOT NULL
                                 REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position               INTEGER NOT NULL,
        type_code              INTEGER NOT NULL,
        role_code              INTEGER NOT NULL,
        parent_position        INTEGER,
        record_offset          INTEGER NOT NULL,
        record_length          INTEGER NOT NULL,
        record_ordinal         INTEGER NOT NULL,
        sub_block_ordinal      INTEGER NOT NULL,
        model                  TEXT,
        client_intent_id       TEXT,
        activity_owner         INTEGER,
        action_start           INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cache_reading_scopes (
        cache_conversation_id INTEGER NOT NULL REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, start)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cache_display_fragments (
        cache_conversation_id INTEGER NOT NULL REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, part TEXT NOT NULL, ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL, speaker TEXT NOT NULL, run_id TEXT, facts_json TEXT NOT NULL,
        PRIMARY KEY(cache_conversation_id, position, part)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_display_runs ON cache_display_fragments(cache_conversation_id,run_id,position,ordinal);
      CREATE TABLE IF NOT EXISTS cache_display_aliases (
        cache_conversation_id INTEGER NOT NULL REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, owner_position INTEGER NOT NULL, owner_part TEXT NOT NULL,
        PRIMARY KEY(cache_conversation_id,position)
      ) WITHOUT ROWID;
      CREATE TABLE cache_display_positions (
        cache_conversation_id INTEGER NOT NULL REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        facts_json TEXT NOT NULL,
        PRIMARY KEY (cache_conversation_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cache_tool_links (
        cache_conversation_id INTEGER NOT NULL
          REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        tool_key BLOB NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, tool_key)
      ) WITHOUT ROWID;

INSERT INTO cache_meta VALUES ('schema_version','18');
