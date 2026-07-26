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

module.exports = { getConfig };
