// Only complete observed title shapes can supply a job name and employer.
// SEO titles repeat the exact role after a four-digit year. An ambiguous
// longer digit run remains unknown instead of becoming part of the employer.
const TITLE_PATTERNS = [
  /^「(?<name>.+)招聘」_(?<company>.+)招聘-BOSS直聘$/,
  /^(?<name>.+)怎么样_(?<company>.*\D)\d{4}年\k<name>前景怎么样-BOSS直聘$/,
  /^(?<name>.+)招聘工资_(?<company>.*\D)\d{4}年\k<name>工资待遇-BOSS直聘$/,
  /^(?<name>.+)就业前景_(?<company>.*\D)\d{4}年\k<name>招聘工资-BOSS直聘$/,
  /^(?<name>.+)工作内容_(?<company>.*\D)\d{4}年\k<name>工作要求-BOSS直聘$/,
  /^「什么是(?<name>.+)」(?<company>.*\D)\d{4}年\k<name>岗位职责-BOSS直聘$/,
];

export function parseBossDetailTitle(title) {
  if (
    typeof title !== 'string' ||
    title.length > 1000 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(title)
  )
    return null;
  const match = TITLE_PATTERNS.map((pattern) => pattern.exec(title)).find(Boolean);
  if (!match) return null;
  const name = match.groups.name.trim();
  const company = match.groups.company.trim();
  if (!name || name.length > 300 || !company || company.length > 300) return null;
  return { name, company };
}
