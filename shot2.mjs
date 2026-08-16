import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1400, height: 300 }, colorScheme: "dark" });
await p.goto("http://localhost:7777/"); await p.waitForSelector(".ev"); await p.waitForTimeout(300);
console.log(await p.locator("#verify").innerText()); await p.close(); await b.close();
