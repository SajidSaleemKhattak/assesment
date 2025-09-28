const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const parseResume = require("./utils/parseResume");

const APPLIED_FILE = path.join(__dirname, "job-applied.json");

function loadAppliedList() {
  try {
    if (fs.existsSync(APPLIED_FILE)) {
      const txt = fs.readFileSync(APPLIED_FILE, "utf-8");
      const data = JSON.parse(txt);
      return Array.isArray(data) ? data : [];
    }
  } catch (_) {}
  return [];
}

function saveAppliedList(list) {
  try {
    fs.writeFileSync(APPLIED_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.warn("⚠️ Unable to write job-applied.json:", err.message);
  }
}

async function acceptCookiesIfPresent(page) {
  try {
    // Adecco commonly uses OneTrust and may also show a custom Dutch button
    const cookieSelectors = [
      "button#onetrust-accept-btn-handler",
      "button:has-text('Alles accepteren')",
      "button:has-text('Akkoord')",
      "button:has-text('Accepteren')",
      "button:has-text('Accept')",
    ];
    for (const sel of cookieSelectors) {
      const btn = await page.waitForSelector(sel, { timeout: 3000 }).catch(() => null);
      if (btn) {
        try { await btn.scrollIntoViewIfNeeded(); } catch (_) {}
        try { await btn.click({ timeout: 2000 }); } catch (_) {}
        // JS click fallback
        try { await page.evaluate((el) => el.click(), btn); } catch (_) {}
        console.log("🍪 Cookies accepted");
        break;
      }
    }
  } catch (_) {
    // ignore
  }
}

async function clickSolliciteerAndGetFormPage(context, page) {
  const sollicitSelectors = [
    "a:has-text('Solliciteer')",
    "button:has-text('Solliciteer')",
    "[role='button']:has-text('Solliciteer')",
  ];

  for (const sel of sollicitSelectors) {
    const hasBtn = await page.$(sel);
    if (!hasBtn) continue;

    // Try to catch a new page, otherwise fall back to same page
    const waitNewPage = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    await page.click(sel);
    const newPage = await waitNewPage;
    const formPage = newPage || page;
    await formPage.waitForLoadState("domcontentloaded");
    return formPage;
  }

  throw new Error("'Solliciteer' button not found");
}

async function fillInputByLabel(page, labels, value) {
  if (value == null) return false;
  for (const label of labels) {
    try {
      const locator = page.getByLabel(label, { exact: false });
      if (await locator.count()) {
        await locator.first().fill(value);
        return true;
      }
    } catch (_) {}

    // Fallback: label element followed by input
    try {
      const input = page.locator(`label:has-text("${label}")`).locator("xpath=following::*[self::input or self::textarea][1]");
      if (await input.count()) {
        await input.first().fill(value);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// Finds an input or textarea that is visually adjacent to a given label text, even if not linked by for/id
async function getInputNearLabel(page, labelText) {
  const candidates = [
    `xpath=//label[contains(normalize-space(.), ${JSON.stringify(labelText)})]`,
    `xpath=//*[self::div or self::span or self::p][contains(normalize-space(.), ${JSON.stringify(labelText)})]`,
  ];
  for (const sel of candidates) {
    const labelLoc = page.locator(sel);
    const count = await labelLoc.count();
    for (let i = 0; i < count; i++) {
      const node = labelLoc.nth(i);
      // Try input/textarea inside same container row
      const within = node.locator("xpath=following::*[self::input or self::textarea][1]");
      if (await within.count()) return within.first();
      // Try ancestor container then find input inside
      const ancestor = node.locator("xpath=ancestor::*[self::div or self::label][1]");
      if (await ancestor.count()) {
        const inputDesc = ancestor.first().locator("xpath=.//input|.//textarea");
        if (await inputDesc.count()) return inputDesc.first();
      }
      // Try sibling container to the right
      const siblingInput = node.locator("xpath=following-sibling::*//input|following-sibling::*//textarea");
      if (await siblingInput.count()) return siblingInput.first();
    }
  }
  return null;
}

async function fillByAdjacentLabel(page, labelText, value) {
  if (value == null) return false;
  const input = await getInputNearLabel(page, labelText);
  if (input) {
    await input.fill(String(value));
    return true;
  }
  return false;
}

async function fillPhoneField(page, labels, value) {
  // Attempt via label first
  let target = null;
  for (const label of labels) {
    const loc = page.getByLabel(label, { exact: false });
    if (await loc.count()) {
      target = loc.first();
      break;
    }
  }
  if (!target) {
    // Fallback to input[type=tel]
    const tel = page.locator("input[type='tel']");
    if (await tel.count()) target = tel.first();
  }
  if (!target) return false;

  const v = value || "0612345678"; // Dutch mobile sample format

  try {
    await target.click();
    await target.press("Control+A").catch(() => {});
    await target.press("Meta+A").catch(() => {});
    await target.press("Backspace");
    await target.type(v, { delay: 60 });
    // Verify value got set
    const got = await target.inputValue();
    if (got && got.replace(/\D/g, "").length >= 8) return true;
  } catch (_) {}

  // Fallback: force set value and dispatch events (for masked inputs)
  try {
    const handle = await target.elementHandle();
    await page.evaluate((el, val) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, handle, v);
    return true;
  } catch (_) {}

  return false;
}

async function autoApply() {
  const jobs = JSON.parse(fs.readFileSync("scraped_jobs.json", "utf-8"));
  if (!jobs.length) {
    console.error("❌ No jobs found in scraped_jobs.json");
    return;
  }

  const resumesDir = path.join(__dirname, "resumes");
  const resumeFiles = fs.readdirSync(resumesDir).filter((f) => f.endsWith(".json"));
  if (!resumeFiles.length) {
    console.error("❌ No resumes found in /resumes folder");
    return;
  }

  const candidate = parseResume(path.join(resumesDir, resumeFiles[0]));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const applied = loadAppliedList();

  for (const job of jobs) {
    console.log(`\n📌 Applying to: ${job.title} (${job.location || ''})`);

    try {
      const page = await context.newPage();
      await page.goto(job.link, { waitUntil: "domcontentloaded", timeout: 60000 });

      await acceptCookiesIfPresent(page);

      const formPage = await clickSolliciteerAndGetFormPage(context, page);

      // Wait for any core form field label to appear
      await formPage.waitForLoadState("domcontentloaded");
      await Promise.race([
        formPage.getByLabel(/Voornaam/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}),
        formPage.getByLabel(/Achternaam/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}),
        formPage.waitForSelector("button:has-text('Solliciteer')", { timeout: 8000 }).catch(() => {}),
      ]);

      // Upload CV - try labeled input first, then any file input(s) in the form
      const cvPath = path.join(resumesDir, candidate.cvFile || "john_doe_cv.pdf");
      if (fs.existsSync(cvPath)) {
        let uploaded = false;
        try {
          const byLabel = formPage.getByLabel(/CV uploaden|CV|Upload/i);
          if (await byLabel.count()) {
            await byLabel.first().setInputFiles(cvPath);
            uploaded = true;
          }
        } catch (_) {}
        if (!uploaded) {
          const fileInputs = await formPage.$$("input[type='file']");
          for (const fi of fileInputs) {
            try { await fi.setInputFiles(cvPath); uploaded = true; break; } catch (_) {}
          }
        }
        if (uploaded) console.log("📄 CV uploaded");
      } else {
        console.warn("⚠️ CV file not found:", cvPath);
      }

      // Fill Dutch-labeled fields
      // Try native label resolution; if not, fall back to adjacent label search
      const fillOrAdjacent = async (labels, val) => {
        if (await fillInputByLabel(formPage, labels, val)) return true;
        for (const l of labels) {
          if (await fillByAdjacentLabel(formPage, l, val)) return true;
        }
        return false;
      };

      await fillOrAdjacent(["Voornaam"], candidate.firstName || "");
      await fillOrAdjacent(["Tussenvoegsel"], candidate.middleName || "");
      await fillOrAdjacent(["Achternaam"], candidate.lastName || "");
      await fillOrAdjacent(["E-mailadres", "E-mail", "Email"], candidate.email || "");
      // Phone: try advanced
      if (!(await fillPhoneField(formPage, ["Telefoonnummer", "Telefoon", "Mobiel"], candidate.phone || ""))) {
        for (const l of ["Telefoonnummer", "Telefoon", "Mobiel"]) {
          const near = await getInputNearLabel(formPage, l);
          if (near) {
            // Some sites wrap phone in .iti (intl-tel-input)
            let target = near;
            const iti = formPage.locator(".iti input[type='tel']");
            if (await iti.count()) target = iti.first();

            // Perform slow typing with retries
            const val = candidate.phone || "0612345678";
            try {
              await target.click();
              await target.press("Control+A").catch(() => {});
              await target.press("Backspace");
              await target.type(val, { delay: 80 });
              const got = await target.inputValue();
              if (got && got.replace(/\D/g, "").length >= 8) break;
            } catch (_) {}
            try {
              const handle = await target.elementHandle();
              await formPage.evaluate((el, v) => {
                el.focus(); el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
              }, handle, val);
            } catch (_) {}
            break;
          }
        }
      }
      await fillOrAdjacent(["Woonplaats", "Plaats", "Stad"], candidate.city || "");
      await fillOrAdjacent(["Postcode", "Post code", "Zip"], candidate.postalCode || candidate.zipCode || "");

      // Motivation / Toelichting
      const filledMotivation = await fillInputByLabel(
        formPage,
        ["Motivatiebrief", "Toelichting", "Motivatie", "Motivatiebrief / Toelichting"],
        candidate.motivation ||
          "Ik ben enthousiast over deze functie en ik denk dat mijn vaardigheden goed aansluiten bij de eisen."
      );
      if (!filledMotivation) {
        // Try adjacent label lookup for motivation
        const taNear = await getInputNearLabel(formPage, "Motivatie");
        const ta = taNear || (await formPage.$("textarea"));
        if (ta) {
          await ta.fill(
            candidate.motivation ||
              "Ik ben enthousiast over deze functie en ik denk dat mijn vaardigheden goed aansluiten bij de eisen."
          );
        }
      }

      // Consent: pick 'Ja' (Yes) if a radio group is present, and check privacyverklaring checkbox
      try {
        const yesRadio = formPage.getByRole('radio', { name: /^Ja$/i });
        if (await yesRadio.count()) {
          await yesRadio.first().check().catch(() => {});
        }
      } catch (_) {}
      try {
        const privacyCb = formPage.getByLabel(/privacyverklaring/i);
        if (await privacyCb.count()) {
          await privacyCb.first().check().catch(() => {});
        } else {
          // Fallback: check all visible, enabled checkboxes
          const checkboxes = formPage.locator("input[type='checkbox']");
          const count = await checkboxes.count();
          for (let i = 0; i < count; i++) {
            const cb = checkboxes.nth(i);
            const checked = await cb.isChecked();
            const disabled = await cb.isDisabled();
            if (!checked && !disabled) {
              await cb.check().catch(() => {});
            }
          }
        }
      } catch (_) {}

      // Submit (Solliciteer)
      const submitSelectors = [
        "button:has-text('Solliciteer')",
        "[type='submit']:has-text('Solliciteer')",
        "button[type='submit']",
      ];
      let submitted = false;
      // Try role-based lookup first
      try {
        const roleBtn = formPage.getByRole('button', { name: /Solliciteer/i });
        if (await roleBtn.count()) {
          await roleBtn.first().scrollIntoViewIfNeeded().catch(() => {});
          await roleBtn.first().click({ timeout: 10000 }).catch(() => {});
          submitted = true;
        }
      } catch (_) {}
      if (!submitted) {
        for (const sel of submitSelectors) {
          const btn = await formPage.$(sel);
          if (btn) {
            try { await btn.scrollIntoViewIfNeeded(); } catch (_) {}
            await btn.click({ timeout: 10000 }).catch(() => {});
            submitted = true;
            break;
          }
        }
      }
      if (!submitted) {
        throw new Error("Submit button not found");
      }

      console.log(`✅ Application submitted for: ${job.title}`);
      // Persist to job-applied.json (dedupe by link)
      try {
        const exists = applied.some((j) => j.link === job.link);
        if (!exists) {
          applied.push({
            title: job.title || "",
            location: job.location || "",
            link: job.link,
            submittedAt: new Date().toISOString(),
          });
          saveAppliedList(applied);
          console.log("💾 Saved to job-applied.json");
        }
      } catch (_) {}
      await formPage.waitForTimeout(3000);

      // Close form page if it was a popup/new tab
      if (formPage !== page) {
        await formPage.close().catch(() => {});
      }
      await page.close().catch(() => {});
    } catch (err) {
      console.error(`❌ Error applying to ${job.title}:`, err.message);
      // continue with next job
    }
  }

  await browser.close();
}

autoApply();
