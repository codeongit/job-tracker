// Workflows customized in this repository after the initial skill import,
// plus their shared codebase-design reference.
// Keep formatting and documentation checks on the same explicit scope.
export const ownedSkillDirectories = [
  '.agents/skills/ask-matt',
  '.agents/skills/code-review',
  '.agents/skills/codebase-design',
  '.agents/skills/diagnosing-bugs',
  '.agents/skills/domain-modeling',
  '.agents/skills/grill-with-docs',
  '.agents/skills/grilling',
  '.agents/skills/implement',
  '.agents/skills/implement-spec',
  '.agents/skills/improve-codebase-architecture',
  '.agents/skills/prototype',
  '.agents/skills/resolving-merge-conflicts',
  '.agents/skills/retro',
  '.agents/skills/tdd',
  '.agents/skills/to-spec',
  '.agents/skills/to-tickets',
  '.agents/skills/triage',
  '.agents/skills/wayfinder',
  '.agents/skills/writing-for-agents',
];

// Shared exclusions for public documentation and maintained skill formatting.
export const skippedDocumentationDirectories = new Set([
  '.git',
  '.local',
  '.agents',
  '.codex',
  'node_modules',
  'test',
  'tests',
  'fixtures',
  '__fixtures__',
  '__tests__',
  'vendor',
  'third-party',
  'third_party',
]);
