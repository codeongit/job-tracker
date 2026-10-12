import { parseBossJobUrl } from './boss-job-url.js';
import { SOURCE_AUTO_FIELDS } from './model.js';

const live = (rows) => rows.filter((row) => !row.deletedAt);
const normalize = (value) =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN');
const isBossPlatform = (value) => !value || /^boss(?:直聘)?$/i.test(value.replace(/\s/g, ''));
const owns = (binding, opportunity, field) =>
  Boolean(
    binding?.autoFields?.split(',').includes(field) &&
    (opportunity[field] || '') ===
      (binding[`lastAuto${field[0].toUpperCase()}${field.slice(1)}`] || ''),
  );

/** Decide validated ordinary job material against the current workspace. Returned fields
 * are application inputs only: they never replace immutable platform evidence. */
export function assessBossJobMaterials({ event, accountNamespace, opportunities, bindings }) {
  const rejected = (status = 'review', targetId = '', bindingId = '') => ({
    status,
    targetId,
    bindingId,
    fieldSources: { company: '', jobName: '' },
    effectiveEvent: event,
    updateFields: [],
    reuseOnly: false,
    reason: status === 'waiting' ? 'missing_job_details' : 'identity_conflict',
  });
  if (event.jobDetails?.source === 'detail_page_conflict') return rejected();
  const incomplete = event.intent === 'review' && !event.jobDetails;
  // The frozen identity projection can encode several old conflicts as review.
  // A nonempty old title does not reveal which conflict occurred.
  if (incomplete && event.jobName.trim())
    return rejected(event.externalJobId ? 'review' : 'waiting');
  const url = parseBossJobUrl(event.canonicalUrl);
  if (!event.externalJobId || !url || url.jobId !== event.externalJobId) return rejected('waiting');

  const matchingBindings = bindings.filter(
    (row) =>
      row.kind === 'opportunity' &&
      row.platform === 'boss' &&
      row.accountNamespace === accountNamespace &&
      row.externalJobId === event.externalJobId,
  );
  if (matchingBindings.some((row) => row.deletedAt)) return rejected();
  const jobBindings = live(matchingBindings);
  if (jobBindings.length > 1) return rejected();
  const binding = jobBindings[0] || null;
  // A binding cannot hide another exact candidate, including a deleted duplicate.
  // Only the existing explicit manual resolution can distinguish those targets.
  const candidates = opportunities.filter(
    (row) =>
      row.externalId === event.externalJobId ||
      parseBossJobUrl(row.url)?.jobId === event.externalJobId,
  );
  if (candidates.length > 1) return rejected();
  const opportunity = binding
    ? opportunities.find((row) => row.id === binding.opportunityId) || null
    : candidates[0] || null;
  const targetId = opportunity?.id || '';
  if (
    (binding &&
      (!opportunity ||
        binding.canonicalUrl !== event.canonicalUrl ||
        (candidates.length && candidates[0].id !== opportunity.id))) ||
    opportunity?.deletedAt ||
    (opportunity &&
      live(bindings).some(
        (row) =>
          row.kind === 'opportunity' &&
          row.platform === 'boss' &&
          row.opportunityId === targetId &&
          (row.accountNamespace !== accountNamespace ||
            row.externalJobId !== event.externalJobId ||
            row.canonicalUrl !== event.canonicalUrl),
      ))
  )
    return rejected('review', incomplete ? '' : targetId, binding?.id || '');

  const localUrl = opportunity && parseBossJobUrl(opportunity.url);
  const exactLocalIdentity = Boolean(
    opportunity &&
    isBossPlatform(opportunity.platform) &&
    (!opportunity.externalId || opportunity.externalId === event.externalJobId) &&
    localUrl?.canonicalUrl === event.canonicalUrl,
  );
  if (incomplete) {
    if (!opportunity) return rejected('waiting');
    if (!exactLocalIdentity || !opportunity.role?.trim() || !opportunity.company?.trim())
      return rejected();
    return {
      status: 'ready',
      targetId,
      bindingId: binding?.id || '',
      fieldSources: { company: 'existing_job_details', jobName: 'existing_job_details' },
      effectiveEvent: { ...event, jobName: opportunity.role, company: opportunity.company },
      updateFields: [],
      reuseOnly: true,
      reason: binding ? 'bound_job_details_available' : 'existing_job_details_available',
    };
  }

  const detail = event.jobDetails;
  const effectiveEvent = detail
    ? {
        ...event,
        jobName: detail.jobName,
        company: detail.company,
        nameSource: 'detail_page_title',
        intent: 'create_or_link',
      }
    : { ...event, company: opportunity?.company || event.company };
  if (opportunity) {
    const comparedCompany = detail ? detail.company : event.company;
    const companyCompatible =
      !opportunity.company ||
      normalize(opportunity.company) === normalize(comparedCompany) ||
      (!detail && exactLocalIdentity) ||
      (detail && (!binding || owns(binding, opportunity, 'company')));
    if (
      !isBossPlatform(opportunity.platform) ||
      (opportunity.externalId && opportunity.externalId !== event.externalJobId) ||
      (opportunity.url && !localUrl) ||
      (localUrl && localUrl.jobId !== event.externalJobId) ||
      !companyCompatible ||
      (opportunity.role &&
        normalize(opportunity.role) !== normalize(effectiveEvent.jobName) &&
        (!detail || !owns(binding, opportunity, 'role')))
    )
      return rejected('review', targetId, binding?.id || '');
  }
  return {
    status: 'ready',
    targetId,
    bindingId: binding?.id || '',
    fieldSources: {
      company: detail
        ? 'detail_page_title'
        : opportunity?.company
          ? 'existing_job_details'
          : 'observation',
      jobName: detail ? 'detail_page_title' : 'observation',
    },
    effectiveEvent,
    updateFields: SOURCE_AUTO_FIELDS.filter(
      (field) =>
        (field !== 'company' || detail || !opportunity?.company) &&
        (field !== 'role' || detail || !opportunity?.role),
    ),
    reuseOnly: false,
    reason: '',
  };
}
