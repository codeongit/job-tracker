import { getDailyRecords } from './daily.js';
import { getOpportunityStatus, live } from './model.js';

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function findCompanyMatches(data, { company = '', role = '', excludeId = '' } = {}) {
  const companyKey = normalizeMatchText(company),
    roleKey = normalizeMatchText(role);
  if (!companyKey) return [];
  return live(data.opportunities)
    .filter(
      (opportunity) =>
        opportunity.id !== excludeId && normalizeMatchText(opportunity.company) === companyKey,
    )
    .map((opportunity, index) => ({
      opportunity,
      sameRole: !!roleKey && normalizeMatchText(opportunity.role) === roleKey,
      index,
    }))
    .sort((a, b) => Number(b.sameRole) - Number(a.sameRole) || a.index - b.index)
    .map(({ opportunity, sameRole }) => ({ opportunity, sameRole }));
}

export function getFilteredOpportunities(data, { query = '', stage = '', date = '' } = {}) {
  const rows = date
      ? getDailyRecords(data, date).opportunityRecords.map((dailyRecord) => ({
          opportunity: dailyRecord.opportunity,
          dailyRecord,
        }))
      : live(data.opportunities).map((opportunity) => ({ opportunity, dailyRecord: null })),
    keyword = query.toLowerCase();

  return rows.filter(
    ({ opportunity }) =>
      (!stage || getOpportunityStatus(opportunity).stage === stage) &&
      `${opportunity.company} ${opportunity.role} ${opportunity.contact || ''}`
        .toLowerCase()
        .includes(keyword),
  );
}
