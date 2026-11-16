import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DRAMA_STYLE_ID, DRAMA_STYLE_CATEGORIES, DRAMA_STYLES, filterDramaStyles, findDramaStyle } from "./drama-styles";
import { DRAMA_STYLE_PROMPT_MAX_LENGTH } from "./style-limits";

test("style ids are unique and the default exists", () => {
    assert.equal(new Set(DRAMA_STYLES.map((style) => style.id)).size, DRAMA_STYLES.length);
    assert.ok(findDramaStyle(DEFAULT_DRAMA_STYLE_ID));
});

test("every category has styles and prompts fit the server limit", () => {
    for (const category of DRAMA_STYLE_CATEGORIES) assert.ok(filterDramaStyles(category.key, "").length > 0, category.label);
    for (const style of DRAMA_STYLES) assert.ok(Array.from(style.prompt).length <= DRAMA_STYLE_PROMPT_MAX_LENGTH, style.name);
});

test("search matches names and tags across categories", () => {
    assert.ok(filterDramaStyles("hot", "仙侠").some((style) => style.id === "3d-guoman"));
    assert.ok(filterDramaStyles("all", "霸总").length >= 2);
});
