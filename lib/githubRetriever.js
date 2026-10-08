// GitHubRetriever — fetches reference content (syllabus text, question banks)
// from this repo over raw.githubusercontent.com. The repo is public, so no
// GitHub token is required for read access.
//
// DECOUPLED FROM THE UNIT-NUMBER CONVENTION (docs/AUDIT.md section C/H).
// This module used to be the thing that capped the whole app at one subject
// and five units: it mapped a bare roman numeral through ROMAN_TO_NUMBER and
// built `docs/syllabus/unit{N}.md` itself, so Unit VI — or any second subject —
// was unreachable without editing this file. Requirement §2 forbids exactly
// that.
//
// The fix is to make path construction the CALLER's business:
//   - fetchByRepoPath(path, config)  — generic, knows nothing about units
//   - fetchSyllabusContext(...)      — now accepts an explicit path, and only
//                                      falls back to the old convention when
//                                      no path is supplied
// lib/assessmentRegistry.js's resolveMaterialSources() is what produces those
// paths now, from `unit.legacy_syllabus_path` — a value in data/assessments.json
// rather than a rule in code. New units point at uploaded material instead and
// never reach this module at all.

// Retained ONLY to support units that still declare no explicit path (every
// unit seeded before the registry existed). Not a limit on new content.
const ROMAN_TO_NUMBER = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

function unitToFileNumber(unit) {
  const n = ROMAN_TO_NUMBER[String(unit).toUpperCase()];
  if (!n) {
    throw new Error(
      `Cannot derive a legacy syllabus path for unit "${unit}" — expected a roman numeral I-V. ` +
      `Set "legacy_syllabus_path" on this unit in data/assessments.json, or attach uploaded ` +
      `material to it, instead of relying on the docs/syllabus/unit{N}.md naming convention.`
    );
  }
  return n;
}

function rawUrl(repoPath, config) {
  const clean = String(repoPath).replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${config.githubOwner}/${config.githubRepo}/${config.githubBranch}/${clean}`;
}

/** Fetches any repo-relative path as text. The only function here that talks to the network. */
async function fetchByRepoPath(repoPath, config) {
  if (!repoPath || typeof repoPath !== "string") {
    throw new Error("fetchByRepoPath needs a repo-relative path.");
  }
  const url = rawUrl(repoPath, config);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not retrieve "${repoPath}" (${url} → ${response.status}). ` +
      `Make sure the file is committed and pushed to the ${config.githubBranch} branch.`
    );
  }
  return response.text();
}

/**
 * Syllabus text for a unit.
 *
 * @param {string} unit        legacy unit key (roman numeral), used only for the fallback path
 * @param {object} config      from lib/config.js
 * @param {string} [repoPath]  explicit path, normally from the registry's
 *                             resolveMaterialSources() → { kind: "repo-path", path }.
 *                             When supplied, `unit` is not consulted at all.
 */
async function fetchSyllabusContext(unit, config, repoPath) {
  const resolved = repoPath || `docs/syllabus/unit${unitToFileNumber(unit)}.md`;
  try {
    return await fetchByRepoPath(resolved, config);
  } catch (e) {
    throw new Error(
      `${e.message} ` +
      `(Resolved from ${repoPath ? "the unit's legacy_syllabus_path" : `the legacy unit-number convention for Unit ${unit}`}.)`
    );
  }
}

/**
 * The committed question bank for a unit, so lib/keywordBankBuilder.js can key
 * its generated keyword bank to real question ids rather than ones Gemini
 * invents. Same explicit-path treatment as fetchSyllabusContext above.
 *
 * @param {string} [repoPath] e.g. the assessment's `question_bank_ref`, when it
 *                            is a repo path rather than a "firestore:" ref.
 */
async function fetchQuestionBank(unit, config, repoPath) {
  const resolved = repoPath || `data/questions-unit${unitToFileNumber(unit)}.json`;
  const text = await fetchByRepoPath(resolved, config);
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`"${resolved}" is not valid JSON: ${e.message}`);
  }
  return data.questions || [];
}

module.exports = { fetchSyllabusContext, fetchQuestionBank, fetchByRepoPath, unitToFileNumber };
