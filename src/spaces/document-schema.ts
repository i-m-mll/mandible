export const SPACE_DOCUMENT_SCHEMA_SQL = [
  `CREATE TABLE space_documents (
    id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
    source TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0)
  )`,
  `CREATE TABLE space_document_addresses (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES space_documents(id) ON DELETE CASCADE,
    item_id TEXT, FOREIGN KEY(space_id,item_id) REFERENCES space_items(space_id,id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX idx_space_document_addresses_space ON space_document_addresses(space_id,id)`,
  `CREATE INDEX idx_space_document_addresses_item ON space_document_addresses(space_id,item_id) WHERE item_id IS NOT NULL`,
  `ALTER TABLE space_document_history ADD COLUMN generation INTEGER CHECK(
    (kind = 'saved-source') = (generation IS NOT NULL) AND
    (generation IS NULL OR (generation >= 0 AND content IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX idx_space_document_history_generation ON space_document_history(space_id,generation) WHERE generation IS NOT NULL`,
  `ALTER TABLE space_publications ADD COLUMN source_history_id TEXT REFERENCES space_document_history(id) ON DELETE RESTRICT`,
  `CREATE TRIGGER space_publication_source_scope BEFORE INSERT ON space_publications
    WHEN NEW.source_history_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM space_document_history
      WHERE id=NEW.source_history_id AND space_id=NEW.space_id AND kind='saved-source'
    )
    BEGIN SELECT RAISE(ABORT, 'publication source must name this Space’s saved generation'); END`,
  `CREATE TRIGGER space_publication_source_immutable BEFORE UPDATE OF source_history_id ON space_publications
    BEGIN SELECT RAISE(ABORT, 'publication source is immutable'); END`,
] as const;
