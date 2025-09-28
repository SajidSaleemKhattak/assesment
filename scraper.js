const { chromium } = require("playwright");
const fs = require("fs-extra");

async function scrapeJobs() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log("🌍 Opening Adecco vacatures page...");
  await page.goto("https://www.adecco.nl/vacatures", {
    waitUntil: "domcontentloaded",
  });

  // 1. Handle cookie popup
  try {
    const cookieBtn = await page.waitForSelector(
      "button#onetrust-accept-btn-handler",
      { timeout: 5000 }
    );
    if (cookieBtn) {
      await cookieBtn.click();
      console.log("🍪 Accepted cookies");
    }
  } catch {
    console.log("🍪 No cookie popup found");
  }

  // 2. Auto-scroll loop until no new jobs load
  let prevHeight = 0;
  let scrollTries = 0;

  while (scrollTries < 5) {
    // give up if nothing loads after 5 tries
    const currHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.mouse.wheel(0, currHeight); // scroll down
    await page.waitForTimeout(2500); // wait for lazy jobs to load

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) {
      scrollTries++; // no more jobs
    } else {
      scrollTries = 0; // reset if new jobs appeared
      prevHeight = newHeight;
    }
  }

  console.log("📜 Finished scrolling, now extracting jobs...");

  // 3. Extract job links
  const jobs = await page.$$eval("a[href*='/vacature/']", (links) =>
    links.map((link) => {
      const title = link.querySelector("h2, h3")?.innerText || "";
      const location =
        link.innerText.match(
          /(Amsterdam|Rotterdam|Utrecht|Den Haag|Eindhoven|Tilburg|Breda)/
        )?.[0] || "";
      return {
        title,
        location,
        salary: "", // salary not always available on listing
        link: link.href,
      };
    })
  );

  console.log(`✅ Found ${jobs.length} jobs`);

  await browser.close();

  // 4. Save jobs to JSON
  fs.writeJSONSync("scraped_jobs.json", jobs, { spaces: 2 });
  console.log("📂 Jobs saved to scraped_jobs.json");
}

scrapeJobs();
