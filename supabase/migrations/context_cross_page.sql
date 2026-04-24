-- context_cross_page — true when the shared set context (scenario / data
-- table / code block) lives on a DIFFERENT page than the question itself.
--
-- Used by the quiz UI to decide whether to render the context_image_path
-- image above the question crop:
--   • true  → cross-page member. Render context image above (the question's
--              own crop does NOT include the context).
--   • false → same-page member (or not grouped). Skip inline context image
--              (already baked into the question crop via applyGroupContextToCrops).
--
-- Separate from context_image_path because we store the context image for
-- every group member (so file-manager can show a "view set info" button on
-- every thumbnail) but only INLINE it in quiz for cross-page cases.

ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS context_cross_page BOOLEAN NOT NULL DEFAULT FALSE;
