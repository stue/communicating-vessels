/**
 * 0.4.3 (R1): the pages as read for this release, as a record (tests/fixtures/pages-read.json, written by
 * `scripts/fixture-cards.mjs --pages <dir> --write` from the saved page set). A test that means "the
 * provider's page, read in this run" passes `READ` to the engine; a test that passes nothing gets the
 * engine's default, a caller that read nothing. No test fetches a page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromRecord, type ReadRecord, type PageRead } from '../../src/pages.js';

export const RECORD_PATH = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/pages-read.json');
export const RECORD: ReadRecord = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
export const READ: PageRead = fromRecord(RECORD);
