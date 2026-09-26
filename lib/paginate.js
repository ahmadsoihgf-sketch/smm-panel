/**
 * Tiny pagination helper. 50 rows per page everywhere.
 * Usage in a route:
 *   const { page, perPage, offset } = getPagination(req);
 *   const total = (await db.get('SELECT COUNT(*) AS c FROM ...', params)).c;
 *   const pg = pageMeta(total, page, perPage); // { page, pages, total }
 *   const rows = await db.query(sql + ' LIMIT ? OFFSET ?', [...params, perPage, pg.offset]);
 *   res.render('view', { ..., page: pg.page, pages: pg.pages, total, qs: buildQs(req.query) });
 */

const PER_PAGE = 50;

function getPagination(req, perPage = PER_PAGE) {
  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  return { page, perPage, offset: (page - 1) * perPage };
}

// Clamp page into range and compute the offset for the (possibly clamped) page.
function pageMeta(total, page, perPage = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(Number(total) / perPage));
  const p = Math.min(page, pages);
  return { page: p, pages, total: Number(total), offset: (p - 1) * perPage };
}

// Rebuild the current query string minus `page`, for pagination links.
function buildQs(query, exclude = ['page']) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (exclude.includes(k) || v === undefined || v === '') continue;
    qs.set(k, v);
  }
  return qs.toString();
}

module.exports = { PER_PAGE, getPagination, pageMeta, buildQs };
