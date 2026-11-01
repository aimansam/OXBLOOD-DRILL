"""Read-only Selenium regression check against a running portal.

Requires Selenium/Chrome, DIVIDE_UI_TEST_TOKEN (operator token), and optionally
DIVIDE_UI_TEST_URL (default http://127.0.0.1:5000). No drill is launched.
Screenshots are saved under DIVIDE_UI_TEST_ARTIFACTS (default /tmp/atlas-check).
"""

import os
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def main():
    token = os.environ["DIVIDE_UI_TEST_TOKEN"]
    url = os.environ.get("DIVIDE_UI_TEST_URL", "http://127.0.0.1:5000").rstrip("/")
    artifacts = Path(os.environ.get("DIVIDE_UI_TEST_ARTIFACTS", "/tmp/atlas-check"))
    artifacts.mkdir(parents=True, exist_ok=True)
    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 30)

    def viewport(width, height):
        driver.execute_cdp_cmd(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": 1,
                "mobile": False,
            },
        )

    def settle():
        # Allow the camera and hover transitions to finish before measuring.
        time.sleep(1)

    def check(label, fitted=False):
        settle()
        errors = driver.execute_script(
            """
          const svg=document.getElementById('scenario-atlas-links');
          const world=document.getElementById('scenario-atlas-world');
          const origin=document.querySelector('.scenario-atlas-origin').getBoundingClientRect();
          const nodes=[...document.querySelectorAll('.scenario-atlas-node')];
          const header=document.querySelector('.scenario-atlas-header').getBoundingClientRect();
          const errors=[];
          if(Math.abs(svg.getBoundingClientRect().width-world.getBoundingClientRect().width)>1)
            errors.push('SVG viewport differs from node world');
          [...svg.querySelectorAll('path')].forEach((path,i)=>{
            const start=path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
            const end=path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM());
            const orb=nodes[i].querySelector('.scenario-atlas-orb').getBoundingClientRect();
            if(Math.hypot(start.x-origin.x-origin.width/2,start.y-origin.y-origin.height/2)>1)
              errors.push('Disconnected origin: '+i);
            if(Math.hypot(end.x-orb.x-orb.width/2,end.y-orb.y-orb.height/2)>orb.width/2)
              errors.push('Disconnected node: '+i);
            const r=nodes[i].getBoundingClientRect();
            if(arguments[0] && (r.top<header.bottom || r.bottom>innerHeight || r.left<0 || r.right>innerWidth))
              errors.push('Clipped or obscured node: '+i);
          });
          return errors;
        """,
            fitted,
        )
        driver.save_screenshot(str(artifacts / (label + ".png")))
        assert not errors, f"{label}: {errors}"
        print(f"PASS {label}", flush=True)

    def click(selector):
        driver.find_element(By.CSS_SELECTOR, selector).click()

    def camera():
        return driver.execute_script("return {...app._scenarioGraphCamera}")

    try:
        viewport(1616, 900)
        driver.get(url + "/login")
        driver.execute_script("localStorage.setItem('divide_token',arguments[0])", token)
        driver.get(url + "/drill/")
        wait.until(lambda d: d.execute_script("return !!window.app && !!app.user"))
        settle()
        driver.execute_script("app.loadPage('scenarios')")
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".scenario-atlas-node"))
        count = len(driver.find_elements(By.CSS_SELECTOR, ".scenario-atlas-node"))
        check("desktop-fit", fitted=True)
        click('.scenario-atlas-zoom [aria-label="Zoom in"]')
        check("zoom-in")
        click('.scenario-atlas-zoom [aria-label="Zoom out"]')
        check("zoom-out")
        before = camera()
        canvas = driver.find_element(By.ID, "scenario-atlas-viewport")
        ActionChains(driver).move_to_element_with_offset(
            canvas, -550, -100
        ).click_and_hold().move_by_offset(95, 50).release().perform()
        after = camera()
        assert abs(after["x"] - before["x"] - 95) < 1
        assert abs(after["y"] - before["y"] - 50) < 1
        assert not driver.execute_script("return getSelection().toString()"), "Drag selected text"
        check("drag")
        click('.scenario-atlas-zoom [title="Fit atlas"]')
        settle()
        click(".scenario-atlas-node .scenario-atlas-orb")
        wait.until(lambda d: d.find_element(By.ID, "scenario-atlas-inspector").is_displayed())
        check("selected")
        before = camera()
        box = driver.find_element(By.ID, "scenario-atlas-inspector").rect
        driver.execute_cdp_cmd(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseWheel",
                "x": box["x"] + box["width"] / 2,
                "y": box["y"] + box["height"] / 2,
                "deltaX": 0,
                "deltaY": 300,
            },
        )
        settle()
        assert camera() == before, "Scrolling the briefing moved the map"
        assert driver.execute_script("""
          const el=document.getElementById('scenario-atlas-inspector');
          return el.scrollHeight<=el.clientHeight || el.scrollTop>0;
        """), "Briefing cannot scroll"
        driver.execute_script("document.getElementById('scenario-atlas-inspector').scrollTop=0")
        click(".scenario-atlas-close")
        check("closed", fitted=True)
        search = driver.find_element(By.ID, "scenario-atlas-search")
        name = driver.find_element(By.CSS_SELECTOR, ".scenario-atlas-node strong").text
        search.send_keys(name)
        wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ".scenario-atlas-node")) < count)
        check("filtered", fitted=True)
        search.clear()
        search.send_keys("no-such-scenario-regression-check")
        wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR, ".scenario-atlas-node"))
        assert driver.find_element(By.CSS_SELECTOR, ".scenario-atlas-empty").is_displayed()
        search.clear()
        driver.execute_script(
            "document.getElementById('scenario-atlas-search').dispatchEvent(new Event('input'))"
        )
        wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ".scenario-atlas-node")) == count)
        for width, height in [(1920, 1080), (1366, 768), (390, 844)]:
            viewport(width, height)
            check(f"fit-{width}", fitted=True)
        before = camera()
        click('.scenario-atlas-zoom [aria-label="Zoom out"]')
        settle()
        assert camera()["scale"] < before["scale"], "Zoom out zoomed inward on mobile"
        check("mobile-zoom-out")
        errors = [e for e in driver.get_log("browser") if e["level"] == "SEVERE"]
        assert not errors, errors
        print(f"Screenshots: {artifacts}")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
