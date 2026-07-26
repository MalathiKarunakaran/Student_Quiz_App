// ConfigurationManager — single place every Hermes module reads env vars
// from, so nothing else in lib/ or api/ touches process.env directly.

function getConfig() {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it as an environment variable in the " +
      "Vercel project (or .env.local for local `vercel dev`) — see .env.example."
    );
  }

  return {
    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    githubOwner: process.env.GITHUB_OWNER || "MalathiKarunakaran",
    githubRepo: process.env.GITHUB_REPO || "Student_Quiz_App",
    githubBranch: process.env.GITHUB_BRANCH || "main",
    maxQuestionsPerRequest: parseInt(process.env.MAX_QUESTIONS_PER_REQUEST, 10) || 40,
    llmMaxRetries: parseInt(process.env.LLM_MAX_RETRIES, 10) || 2,
  };
}

// Separate from getConfig() above (which throws immediately if GEMINI_API_KEY
// is missing) because api/grade-open-ended.js never touches Gemini at all —
// it should not fail just because question-generation is unconfigured.
function getFirebaseConfig() {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!serviceAccountBase64) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Base64-encode your Firebase " +
      "service-account JSON and add it as an environment variable — see docs/firebase-setup.md."
    );
  }

  const teacherEmails = (process.env.TEACHER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    serviceAccountBase64,
    teacherEmails,
    maxSyllabusUploadBytes: parseInt(process.env.MAX_SYLLABUS_UPLOAD_BYTES, 10) || 5 * 1024 * 1024,
  };
}

module.exports = { getConfig, getFirebaseConfig };
