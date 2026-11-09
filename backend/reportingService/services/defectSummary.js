const { requestWithRetry } = require('@srckube/service-core');
const { DEFECT_SERVICE, ISTATUS_SERVICE } = require('./serviceUrls');

const AGE_BUCKETS = [
  { id: '0-7d', label: '0-7 days', maxDays: 7 },
  { id: '8-30d', label: '8-30 days', maxDays: 30 },
  { id: '31-90d', label: '31-90 days', maxDays: 90 },
  { id: '90d+', label: '90+ days', maxDays: Infinity }
];

function ageBucketFor(createdAt, now) {
  const ageDays = (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return AGE_BUCKETS.find((b) => ageDays <= b.maxDays) || AGE_BUCKETS[AGE_BUCKETS.length - 1];
}

// defectService's `Status` field stores EITHER the istatus numeric id (as a
// Number or a String, e.g. 1, '8') OR the istatus name (e.g. 'New') -- see
// releaseService/controllers/releases.js's resolveStatusId, which this is
// copied from verbatim (same dependency pair, defectService + istatusservice,
// same real-data ambiguity; there is no shared library home for this today,
// same situation WP-025 was already in with no earlier precedent to reuse).
function resolveStatusName(rawStatus, statusList) {
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
    return 'Unknown';
  }
  const asNumber = Number(rawStatus);
  if (Number.isInteger(asNumber)) {
    const byId = statusList.find((s) => s.id === asNumber);
    if (byId) {
      return byId.istatus;
    }
  }
  const byName = statusList.find((s) => (s.istatus || '').toLowerCase() === String(rawStatus).toLowerCase());
  return byName ? byName.istatus : 'Unknown';
}

function tally(items, keyFn) {
  const counts = new Map();
  items.forEach((item) => {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

// WP-040 — defect counts by status/severity/age, all scoped to the caller's
// project (defectService is tenant-scoped since WP-021 -- the X-Project-Id
// header this forwards does the real filtering, same as releaseService's
// evaluateMaxOpenDefects).
async function computeDefectSummary(projectId, headers) {
  if (!DEFECT_SERVICE) {
    throw new Error('defectService is not configured');
  }
  if (!ISTATUS_SERVICE) {
    throw new Error('istatusService is not configured');
  }

  const [defectsResp, statusResp] = await Promise.all([
    requestWithRetry({
      method: 'get',
      url: `http://${DEFECT_SERVICE}/api/v1/defects`,
      params: { limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${ISTATUS_SERVICE}/api/v1/issuestatus`,
      params: { limit: 1000 },
      headers
    })
  ]);

  const defects = (defectsResp.data && defectsResp.data.data) || [];
  const statusList = (statusResp.data && statusResp.data.data) || [];
  const now = new Date();

  const statusCounts = tally(defects, (d) => resolveStatusName(d.Status, statusList));
  const severityCounts = tally(defects, (d) => d.Severity || 'Unspecified');
  const ageCounts = tally(defects, (d) => ageBucketFor(d.createdAt, now).id);

  const statusCategories = Array.from(statusCounts.keys());
  const severityIds = Array.from(severityCounts.keys());
  const ageCategories = AGE_BUCKETS.map((b) => b.id);

  return {
    total: defects.length,
    // BarChart-shaped (frontend/src/Components/charts/BarChart.tsx:
    // {categories, series}).
    byStatus: {
      categories: statusCategories,
      series: [{ id: 'count', label: 'Defects', data: statusCategories.map((c) => statusCounts.get(c)) }]
    },
    // DonutChart-shaped (frontend/src/Components/charts/DonutChart.tsx:
    // {data: [{id,label,value}]}) -- severity is a part-to-whole share of
    // one project's open+closed defects, exactly what DonutChart is for.
    bySeverity: {
      data: severityIds.map((id) => ({ id, label: id, value: severityCounts.get(id) }))
    },
    // BarChart-shaped, fixed bucket order (not sorted by count) so the
    // x-axis always reads youngest -> oldest left to right.
    byAge: {
      categories: AGE_BUCKETS.map((b) => b.label),
      series: [{ id: 'count', label: 'Defects', data: ageCategories.map((id) => ageCounts.get(id) || 0) }]
    }
  };
}

module.exports = { computeDefectSummary };
