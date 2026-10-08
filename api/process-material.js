// Vercel serverless function — POST /api/process-material
// Teacher-only. Step 2 of the §3 lifecycle: turns an uploaded material's
// extracted text into the structured knowledge object (topics, learning
// outcomes, course outcomes, concepts, keywords, technical terms,
// definitions, expected answer concepts) and stores it on the material.
//
// Also serves as the read endpoint for the REVIEW step: GET-style retrieval
// via { material_id, action: "get" } returns the stored record so the teacher
// panel can render what was extracted before anything is published.

const { verifyTeacherToken } = require("../lib/firebaseAdmin");
const { getConfig } = require("../lib/config");
const { processMaterial } = require("../lib/materialProcessor");
const MaterialStore = require("../lib/materialStore");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  let materialId;
  try {
    const decoded = await verifyTeacherToken(req.headers.authorization);
    const { material_id, action, force, subject_hint, unit_hint } = req.body || {};
    materialId = material_id;

    if (!material_id) {
      const err = new Error("material_id is required.");
      err.statusCode = 400;
      throw err;
    }

    // --- Read-only actions, for the review screen ---------------------------
    if (action === "get") {
      res.status(200).json({ material: await MaterialStore.getMaterial(material_id) });
      return;
    }
    if (action === "list") {
      res.status(200).json({
        materials: await MaterialStore.listMaterials({
          subject_id: req.body.subject_id, unit_id: req.body.unit_id, status: req.body.status,
        }),
      });
      return;
    }
    if (action === "download-url") {
      res.status(200).json(await MaterialStore.getDownloadUrl(material_id));
      return;
    }
    if (action === "delete") {
      await MaterialStore.deleteMaterial(material_id);
      res.status(200).json({ deleted: true, material_id });
      return;
    }

    // --- Process ------------------------------------------------------------
    const material = await MaterialStore.getMaterial(material_id);

    if (material.status === "processed" && !force) {
      res.status(200).json({
        skipped: true,
        reason: "This material has already been processed — pass force:true to re-run the analysis.",
        material,
      });
      return;
    }

    // Marked before the Gemini call, not after, so a teacher refreshing the
    // panel mid-run sees "processing" rather than a stale "uploaded" and
    // clicking again.
    await MaterialStore.setStatus(material_id, "processing");

    const result = await processMaterial({
      materialText: material.extracted_text,
      filename: material.filename,
      subjectHint: subject_hint || material.subject_id,
      unitHint: unit_hint || material.unit_id,
    }, getConfig());

    await MaterialStore.saveMetadata(material_id, {
      metadata: result.metadata,
      warnings: result.warnings,
      processedBy: decoded.email,
      model: result.model,
    });

    res.status(200).json({
      skipped: false,
      material_id,
      metadata: result.metadata,
      warnings: result.warnings,
      truncated: result.truncated,
      charsAnalysed: result.charsAnalysed,
      model: result.model,
      // §3: processing is explicitly NOT publishing. The teacher reviews this
      // metadata and then publishes an assessment built on it.
      nextStep: "Review the extracted metadata, then create and publish an assessment against this material.",
    });
  } catch (err) {
    // Leave a failed material in a state that explains itself, rather than
    // stuck on "processing" forever after a Gemini timeout.
    if (materialId) {
      try {
        await MaterialStore.setStatus(materialId, "failed", { processing_warnings: [err.message] });
      } catch (_e) { /* the original error is what matters */ }
    }
    res.status(err.statusCode || 500).json({ error: err.message || "Processing failed." });
  }
};
