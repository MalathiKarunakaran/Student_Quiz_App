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

// Fetches the current static question bank for a unit (data/questions-unit{N}.json)
// from the same public repo/branch, so lib/keywordBankBuilder.js can key its
// generated keyword bank to real question ids rather than ones Gemini invents.
async function fetchQuestionBank(unit, config) {
  const fileNumber = unitToFileNumber(unit);
  const url = `https://raw.githubusercontent.com/${config.githubOwner}/${config.githubRepo}/${config.githubBranch}/data/questions-unit${fileNumber}.json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not retrieve the question bank for Unit ${unit} (${url} → ${response.status}). ` +
      `Make sure data/questions-unit${fileNumber}.json is committed and pushed.`
    );
  }
  const data = await response.json();
  return data.questions || [];
}

module.exports = { fetchSyllabusContext, unitToFileNumber, fetchQuestionBank };
