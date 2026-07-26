/**
 * teacher-config.js
 * ---------------------------------------------------------------------------
 * Drives teacher.html: loads the question bank to discover available
 * topics/types/etc., builds the filter UI dynamically, and produces either
 * (a) a downloadable config JSON to commit to the repo, or
 * (b) a self-contained shareable link with the config base64-encoded in the
 *     URL — this second option requires ZERO repo changes per quiz and is
 *     the recommended day-to-day workflow.
 * ---------------------------------------------------------------------------
 */

let loadedBank = [];

async function initTeacherPanel() {
  const bankPath = document.getElementById('bankPath').value;
  try {
    loadedBank = await DataLoader.loadQuestionBank(bankPath);
    populateFilterUI(loadedBank);
    document.getElementById('filterSection').style.display = 'block';
    document.getElementById('bankLoadError').innerHTML = '';
    document.getElementById('bankStats').textContent =
      `Loaded ${loadedBank.length} questions from ${bankPath}.`;
  } catch (e) {
    document.getElementById('bankLoadError').innerHTML =
      `<div class="error-box">Could not load question bank: ${e.message}</div>`;
  }
}

function uniqueValues(bank, field) {
  return [...new Set(bank.map(q => q[field]))].sort();
}

function populateFilterUI(bank) {
  const topics = uniqueValues(bank, 'topic');
  const types = uniqueValues(bank, 'type');
  const difficulties = ['easy', 'medium', 'hard'].filter(d => bank.some(q => q.difficulty === d));
  const blooms = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'].filter(b => bank.some(q => q.bloom === b));

  fillCheckboxGrid('topicFilters', topics, topics); // default: all checked
  fillCheckboxGrid('typeFilters', types, types);
  fillCheckboxGrid('difficultyFilters', difficulties, difficulties);
  fillCheckboxGrid('bloomFilters', blooms, blooms);

  document.getElementById('numQuestions').max = bank.length;
  document.getElementById('numQuestions').value = Math.min(10, bank.length);
  document.getElementById('bankStatsMatching').textContent = `${bank.length} questions available with current filters.`;
  renderCoStats(bank);
}

/** Course Outcome coverage for the currently-matching question set (Section 2, teacher panel). */
function renderCoStats(matching) {
  const el = document.getElementById('coStats');
  if (!el) return;
  const counts = {};
  matching.forEach(q => {
    const co = q.co || 'Untagged';
    counts[co] = (counts[co] || 0) + 1;
  });
  const cos = Object.keys(counts).sort();
  if (cos.length === 0) { el.textContent = ''; return; }
  const parts = cos.map(co => `${co}: ${counts[co]} question${counts[co] !== 1 ? 's' : ''} (${Math.round(counts[co] / matching.length * 100)}%)`);
  el.textContent = `Course Outcome coverage — ${parts.join(' · ')}`;
}

function fillCheckboxGrid(containerId, values, checkedValues) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  values.forEach(v => {
    const id = containerId + '-' + v.replace(/\s+/g, '_');
    const wrapper = document.createElement('label');
    wrapper.className = 'checkbox-item';
    wrapper.innerHTML = `<input type="checkbox" value="${v}" ${checkedValues.includes(v) ? 'checked' : ''} onchange="updateMatchingCount()"> ${v}`;
    container.appendChild(wrapper);
  });
}

function getCheckedValues(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input:checked`)).map(i => i.value);
}

function updateMatchingCount() {
  const filters = buildFiltersFromUI();
  const matching = loadedBank.filter(q =>
    filters.topics.includes(q.topic) &&
    filters.difficulty.includes(q.difficulty) &&
    filters.bloomLevels.includes(q.bloom) &&
    filters.questionTypes.includes(q.type)
  );
  document.getElementById('bankStatsMatching').textContent = `${matching.length} questions available with current filters.`;
  document.getElementById('numQuestions').max = matching.length;
  renderCoStats(matching);
}

function buildFiltersFromUI() {
  return {
    unit: document.getElementById('unitSelect').value,
    topics: getCheckedValues('topicFilters'),
    difficulty: getCheckedValues('difficultyFilters'),
    bloomLevels: getCheckedValues('bloomFilters'),
    questionTypes: getCheckedValues('typeFilters')
  };
}

function buildConfigFromUI() {
  return {
    quizId: document.getElementById('quizId').value || ('quiz-' + Date.now()),
    quizTitle: document.getElementById('quizTitle').value || 'Untitled Quiz',
    questionBankFile: document.getElementById('bankPath').value,
    filters: buildFiltersFromUI(),
    numQuestions: parseInt(document.getElementById('numQuestions').value, 10) || 10,
    randomizationMode: document.getElementById('randomizationMode').value,
    seedSource: 'rollNumber',
    shuffleOptions: document.getElementById('shuffleOptions').checked,
    timeLimitMinutes: parseInt(document.getElementById('timeLimit').value, 10) || 25,
    showExplanationsAfterSubmit: document.getElementById('showExplanations').checked,
    passingPercentage: parseInt(document.getElementById('passingPct').value, 10) || 50,
    allowReviewBeforeSubmit: document.getElementById('allowReview').checked,
    autoSubmitOnTimeout: true,
    negativeMarking: {
      enabled: document.getElementById('negMarkingEnabled').checked,
      penaltyFraction: parseFloat(document.getElementById('negMarkingFraction').value) || 0.25
    },
    violationPolicy: {
      mode: document.getElementById('violationMode').value,
      maxViolations: parseInt(document.getElementById('maxViolations').value, 10) || 3
    },
    generatePdfReport: document.getElementById('pdfReportEnabled').checked
  };
}

function generateShareableLink() {
  const config = buildConfigFromUI();
  const encoded = DataLoader.encodeConfigToBase64(config);
  const baseUrl = window.location.href.replace(/teacher\.html.*$/, 'student.html');
  // The base64 alphabet includes '+' and '/', which a browser's URLSearchParams
  // parser will corrupt ('+' silently decodes to a space) unless percent-encoded.
  const link = `${baseUrl}?config=${encodeURIComponent(encoded)}`;
  const output = document.getElementById('linkOutput');
  output.style.display = 'block';
  output.innerHTML = `
    <label>Shareable Student Link (send this — no repo changes needed):</label>
    <input type="text" readonly value="${link}" onclick="this.select()">
    <div class="btn-row">
      <button class="btn-secondary" onclick="navigator.clipboard.writeText('${link}').then(()=>alert('Link copied!'))">Copy Link</button>
    </div>
  `;
}

function downloadConfigFile() {
  const config = buildConfigFromUI();
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `config-${config.quizId}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Hermes Agent integration — reads the requested Bloom-level percentages
 * (six number inputs, one per level, in the "Generate with AI" card).
 */
const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];

function readBloomDistributionFromUI() {
  const dist = {};
  BLOOM_LEVELS.forEach(level => {
    const el = document.getElementById('bloomPct-' + level);
    if (el) dist[level] = parseInt(el.value, 10) || 0;
  });
  return dist;
}

function renderAiGenerationMeta(meta) {
  const el = document.getElementById('aiGenerateMeta');
  if (!el) return;
  const parts = [`${meta.generated}/${meta.requested} generated`];
  if (meta.droppedInvalid) parts.push(`${meta.droppedInvalid} dropped (invalid)`);
  if (meta.droppedDuplicate) parts.push(`${meta.droppedDuplicate} dropped (duplicate)`);
  el.textContent = `Hermes Agent: ${parts.join(' · ')} · model ${meta.model}`;
}

/**
 * Calls the Hermes Agent (POST /api/generate-questions) using the same
 * topic/difficulty/type checkboxes already populated by populateFilterUI(),
 * plus the Bloom-distribution and question-count fields in the AI card.
 * On success, the new questions are appended to loadedBank (the existing
 * static bank is never discarded) and the whole filter/settings pipeline is
 * refreshed exactly as if a bigger static bank had been loaded.
 */
/** Reads a File as base64 (no "data:...;base64," prefix — the server expects raw base64). */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",").pop());
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads the syllabus file selected in Step 5 and calls the Hermes keyword-
 * bank endpoint (/api/generate-keywords), teacher-auth-gated. On success, the
 * generated bank is stored server-side in Firestore (keywordBanks/{unit}) —
 * nothing further is needed client-side for student.html's grading to pick
 * it up automatically on next submit.
 */
async function generateKeywordBankFromSyllabus() {
  const errorEl = document.getElementById('keywordBankError');
  const statusEl = document.getElementById('keywordBankStatus');
  const metaEl = document.getElementById('keywordBankMeta');
  const button = document.getElementById('keywordBankGenerateBtn');
  const fileInput = document.getElementById('syllabusFile');

  errorEl.innerHTML = '';
  metaEl.textContent = '';

  const file = fileInput.files[0];
  if (!file) {
    errorEl.innerHTML = '<div class="error-box">Choose a .docx or .pdf syllabus file first.</div>';
    return;
  }

  button.disabled = true;
  statusEl.style.display = 'flex';

  try {
    const idToken = await AuthGuard.getIdToken();
    const fileBase64 = await readFileAsBase64(file);
    const unit = document.getElementById('unitSelect').value;
    const unitTitle = document.getElementById('unitSelect').selectedOptions[0].textContent;

    const result = await DataLoader.generateKeywords({
      unit,
      unitTitle,
      filename: file.name,
      fileBase64,
      forceRegenerate: document.getElementById('forceRegenerate').checked
    }, idToken);

    if (result.skipped) {
      metaEl.textContent = result.reason;
    } else {
      metaEl.textContent = `Keyword bank generated: ${result.coverage.generated}/${result.coverage.requested} questions covered` +
        (result.coverage.droppedCount ? `, ${result.coverage.droppedCount} dropped (invalid)` : '') +
        ` · model ${result.model}.`;
    }
  } catch (e) {
    errorEl.innerHTML = `<div class="error-box">Keyword bank generation failed: ${e.message}</div>`;
  } finally {
    button.disabled = false;
    statusEl.style.display = 'none';
  }
}

async function generateQuestionsWithAI() {
  const errorEl = document.getElementById('aiGenerateError');
  const statusEl = document.getElementById('aiGenerateStatus');
  const button = document.getElementById('aiGenerateBtn');

  errorEl.innerHTML = '';
  button.disabled = true;
  statusEl.style.display = 'flex';

  try {
    const payload = {
      unit: document.getElementById('unitSelect').value,
      courseOutcome: document.getElementById('aiCourseOutcome').value || 'CO1',
      topics: getCheckedValues('topicFilters'),
      difficulty: getCheckedValues('difficultyFilters'),
      questionTypes: getCheckedValues('typeFilters'),
      bloomDistribution: readBloomDistributionFromUI(),
      numQuestions: parseInt(document.getElementById('aiNumQuestions').value, 10) || 10
    };

    const result = await DataLoader.generateQuestions(payload);
    loadedBank = loadedBank.concat(result.questions);
    populateFilterUI(loadedBank);
    document.getElementById('bankStats').textContent =
      `Loaded ${loadedBank.length} questions (includes ${result.questions.length} newly AI-generated).`;
    renderAiGenerationMeta(result.meta);
  } catch (e) {
    errorEl.innerHTML = `<div class="error-box">AI generation failed: ${e.message}</div>`;
  } finally {
    button.disabled = false;
    statusEl.style.display = 'none';
  }
}
