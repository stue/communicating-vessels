/**
 * The ledger generator's row check (Amendment B, ruling 3; tested since Amendment C):
 * a row built from a page table is accepted only if every one of its cells appears, in
 * order, inside ONE of the page's own rows — a row stitched from two page rows is refused.
 */
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/** @param {string[]} pageRows the page's rows, as text  @param {string[]} cells the cells of one ledger row */
export function oneRowIn(pageRows, cells) {
  return pageRows.some((row) => {
    const seg = flat(row);
    let at = 0;
    for (const c of cells) {
      const i = seg.indexOf(flat(c), at);
      if (i === -1) return false;
      at = i + flat(c).length;
    }
    return true;
  });
}
