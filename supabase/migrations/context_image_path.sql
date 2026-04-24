-- context_image_path — Cloudinary crop URL of the shared context block (e.g.
-- the scenario / data table / code block of a "סט" set) on its OWN page.
--
-- Only populated for cross-page set members — a page-2 sub-question of a set
-- whose scenario lives on page 1 gets this URL stored so the quiz UI can
-- render the page-1 scenario image ABOVE the question's own crop.
--
-- Same-page set members leave this column NULL because their own crop already
-- includes the context (via applyGroupContextToCrops extending yTop upward).

ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS context_image_path TEXT;
