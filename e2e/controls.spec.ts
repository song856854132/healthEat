import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { makeAccount } from "./helpers";

// T34: controls you can see and reach, app-wide (v2 UI design, change list): a darker border for
// inputs, selects and buttons, a keyboard focus outline on every control, and 44px targets on phones.

const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => {
    // Resolve the token to the same rgb() form getComputedStyle uses for colours.
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);

const style = (
  el: Locator,
  prop: "borderTopColor" | "borderBottomColor" | "outlineStyle" | "outlineWidth",
) => el.evaluate((node, p) => getComputedStyle(node)[p], prop);

const height = async (el: Locator) => (await el.boundingBox())!.height;

test("inputs and buttons have the darker control border; section outlines keep the light line", async ({
  page,
}) => {
  await page.goto("/register");
  const control = await cssVar(page, "--control-line");
  const line = await cssVar(page, "--line");
  expect(control).not.toBe(line);
  await expect(page.getByLabel("Username")).toBeVisible({ timeout: 30_000 });
  expect(await style(page.getByLabel("Username"), "borderTopColor")).toBe(control);
  // A plain button (the privacy notice's) takes the control border; the page's one primary button
  // keeps its filled ink look.
  expect(await style(page.getByRole("button", { name: "Got it" }), "borderTopColor")).toBe(control);
  expect(await style(page.getByRole("button", { name: "Create account" }), "borderTopColor")).toBe(
    await cssVar(page, "--ink"),
  );
  // The header's rule (its bottom border) keeps the light line.
  expect(await style(page.locator(".site-header"), "borderBottomColor")).toBe(line);

  // An invalid field still shows its danger border.
  await page.getByLabel("Username").fill("No Spaces!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByLabel("Username")).toHaveAttribute("aria-invalid", "true");
  expect(await style(page.getByLabel("Username"), "borderTopColor")).toBe(
    await cssVar(page, "--danger"),
  );
});

test("keyboard focus draws a 2px outline on controls; a mouse click on a button draws none", async ({
  page,
}) => {
  await page.goto("/login");
  const username = page.getByLabel("Username");
  await expect(username).toBeVisible({ timeout: 30_000 });
  await username.focus();
  await page.keyboard.press("Tab"); // to Password, by keyboard
  const password = page.getByLabel("Password");
  await expect(password).toBeFocused();
  expect(await style(password, "outlineStyle")).toBe("solid");
  expect(await style(password, "outlineWidth")).toBe("2px");

  const submit = page.getByRole("button", { name: "Log in" });
  await submit.click();
  expect(await style(submit, "outlineStyle")).toBe("none");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("controls, nav and footer links are at least 44px tall", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Username")).toBeVisible({ timeout: 30_000 });
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const el of [
      page.getByLabel("Username"),
      page.getByLabel("Password"),
      page.getByRole("button", { name: "Log in" }),
      nav.getByRole("link", { name: "Log in" }),
      nav.getByRole("link", { name: "Register" }),
      page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "About" }),
    ])
      expect(await height(el)).toBeGreaterThanOrEqual(44);
  });

  test("a member's day log: the day links and the add buttons are at least 44px tall", async ({
    page,
  }) => {
    const reg = await page.request.post("/api/auth/register", { data: makeAccount("ctl") });
    expect(reg.status(), await reg.text()).toBe(201);
    await page.goto("/log");
    await expect(page.getByTestId("day-add-food")).toBeVisible({ timeout: 30_000 });
    for (const el of [
      page.getByTestId("day-add-food"),
      page.getByTestId("day-add-photo"),
      page.getByRole("link", { name: "← Previous day" }),
      page.getByRole("button", { name: "Log out" }),
    ])
      expect(await height(el)).toBeGreaterThanOrEqual(44);

    // Home's log bar: its own module rules, so measured too.
    await page.goto("/");
    const bar = page.getByTestId("log-bar");
    await expect(bar).toBeVisible({ timeout: 30_000 });
    for (const el of [bar.getByRole("searchbox"), bar.getByRole("button", { name: "Search" })])
      expect(await height(el)).toBeGreaterThanOrEqual(44);
  });

  test("the search form's box, data type and button are at least 44px tall", async ({ page }) => {
    await page.goto("/search");
    const box = page.getByRole("searchbox", { name: "Food" });
    await expect(box).toBeVisible({ timeout: 30_000 });
    for (const el of [
      box,
      page.getByRole("combobox"),
      page.getByRole("button", { name: "Search" }),
    ])
      expect(await height(el)).toBeGreaterThanOrEqual(44);
  });
});
