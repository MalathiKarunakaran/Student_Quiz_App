// GitHubRetriever — fetches syllabus/topic reference content for a unit from
// this repo's docs/syllabus folder via raw.githubusercontent.com. The repo is
// public, so no GitHub token is required for read access.

const ROMAN_TO_NUMBER = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

function unitToFileNumber(unit) {
  const n = ROMAN_TO_NUMBER[String(unit).toUpperCase()];
  if (!n) {
    throw new Error(`Unknown unit "${unit}" — expected a roman numeral I-V.`);
  }
  return n;
}

async function fetchSyllabusContext(unit, config) {
  const fileNumber = unitToFileNumber(unit);
  const url = `https://raw.githubusercontent.com/${config.githubOwner}/${config.githubRepo}/${config.githubBranch}/docs/syllabus/unit${fileNumber}.md`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not retrieve syllabus content for Unit ${unit} (${url} → ${response.status}). ` +
      `Add docs/syllabus/unit${fileNumber}.md to the repo before generating questions for this unit.`
    );
  }
  return response.text();
}

module.exports = { fetchSyllabusContext, unitToFileNumber };
