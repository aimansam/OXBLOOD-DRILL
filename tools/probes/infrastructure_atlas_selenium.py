"""Read-only live Infrastructure UI checks; requires Selenium and Chrome.

Set DIVIDE_UI_TEST_TOKEN to an admin token. Optional DIVIDE_UI_TEST_URL defaults
to http://127.0.0.1:5000. Use --inspect to capture baseline defects without
asserting. Screenshots go to /tmp/infrastructure-atlas-check by default.
No infrastructure mutation buttons are used.
"""

import json
import os
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def main():
    token = os.environ["DIVIDE_UI_TEST_TOKEN"]
    url = os.environ.get("DIVIDE_UI_TEST_URL", "http://127.0.0.1:5000").rstrip("/")
    artifacts = Path(os.environ.get("DIVIDE_UI_TEST_ARTIFACTS", "/tmp/infrastructure-atlas-check"))
    artifacts.mkdir(parents=True, exist_ok=True)
    inspect = "--inspect" in sys.argv
    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 45)

    def resize(width, height):
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
        time.sleep(1)

    def click(selector):
        driver.find_element(By.CSS_SELECTOR, selector).click()

    def camera():
        return driver.execute_script("return {...app._infrastructureGraphCamera}")

    def check(label, fitted=False):
        settle()
        result = driver.execute_script(
            """
          const svg=document.getElementById('infrastructure-atlas-links');
          const world=document.getElementById('infrastructure-atlas-world');
          const origin=document.querySelector('.infrastructure-atlas-origin')?.getBoundingClientRect();
          const nodes=[...document.querySelectorAll('.infrastructure-atlas-node')];
          const header=document.querySelector('.infrastructure-atlas-header').getBoundingClientRect();
          const paths=[...svg.querySelectorAll('path')];
          const errors=[];
          let offset=0;
          if(Math.abs(svg.getBoundingClientRect().width-world.getBoundingClientRect().width)>1)
            errors.push('SVG viewport differs from node world');
          if(paths.length!==nodes.length) errors.push('Edge/node count mismatch');
          paths.forEach((path,i)=>{
            const start=path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
            const end=path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM());
            const orb=nodes[i].querySelector('.infrastructure-atlas-orb').getBoundingClientRect();
            offset=Math.max(offset,Math.hypot(start.x-origin.x-origin.width/2,start.y-origin.y-origin.height/2));
            if(offset>1) errors.push('Disconnected origin: '+i);
            if(Math.hypot(end.x-orb.x-orb.width/2,end.y-orb.y-orb.height/2)>orb.width/2)
              errors.push('Disconnected node: '+i);
            if(getComputedStyle(nodes[i],'::before').display!=='none') errors.push('Duplicate node decoration: '+i);
            const r=nodes[i].getBoundingClientRect();
            const label=nodes[i].querySelector('.infrastructure-atlas-node-status').getBoundingClientRect();
            if(arguments[0] && (r.top<header.bottom || Math.max(r.bottom,label.bottom)>innerHeight || r.left<0 || r.right>innerWidth))
              errors.push('Clipped or obscured node: '+i);
          });
          return {errors,originOffset:offset,nodes:nodes.length};
        """,
            fitted,
        )
        driver.save_screenshot(str(artifacts / (label + ".png")))
        print(label, json.dumps(result), flush=True)
        if not inspect:
            assert not result["errors"], label

    try:
        resize(1616, 900)
        driver.get(url + "/login")
        driver.execute_script("localStorage.setItem('divide_token',arguments[0])", token)
        driver.get(url + "/drill/")
        wait.until(lambda d: d.execute_script("return !!window.app && !!app.user"))
        settle()
        driver.execute_script("app.loadPage('infrastructure')")
        wait.until(
            lambda d: len(d.find_elements(By.CSS_SELECTOR, ".infrastructure-atlas-node")) == 7
        )
        check("baseline" if inspect else "desktop-fit", fitted=True)
        if inspect:
            driver.execute_script("app.focusInfrastructureNode('guests')")
            settle()
            print(
                "inspector-close-hit",
                driver.execute_script("""
              const b=document.querySelector('.infrastructure-atlas-close');
              const r=b.getBoundingClientRect();
              return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML;
            """),
            )
            check("baseline-inspector")
            return
        click('.infrastructure-atlas-zoom [aria-label="Zoom in"]')
        check("zoom-in")
        click('.infrastructure-atlas-zoom [aria-label="Zoom out"]')
        check("zoom-out")
        before = camera()
        canvas = driver.find_element(By.ID, "infrastructure-atlas-viewport")
        ActionChains(driver).move_to_element_with_offset(
            canvas, -550, -100
        ).click_and_hold().move_by_offset(95, 50).release().perform()
        assert abs(camera()["x"] - before["x"] - 95) < 1
        assert abs(camera()["y"] - before["y"] - 50) < 1
        assert not driver.execute_script("return getSelection().toString()"), "Drag selected text"
        check("drag")
        click('.infrastructure-atlas-zoom [title="Fit inventory"]')
        settle()
        for node_id in [
            "pve",
            "templates",
            "storage",
            "networks",
            "cleanup",
            "health",
            "overview",
            "guests",
        ]:
            click(f'.infrastructure-atlas-nodes [data-node-id="{node_id}"]')
            wait.until(
                lambda d: d.find_element(By.ID, "infrastructure-atlas-inspector").is_displayed()
            )
            check("selected-" + node_id)
            if node_id == "guests":
                before = camera()
                box = driver.find_element(By.ID, "infrastructure-atlas-inspector").rect
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
                assert camera() == before, "Inspector scroll zoomed the map"
                assert driver.execute_script("""
                  const el=document.getElementById('infrastructure-atlas-inspector');
                  return el.scrollHeight<=el.clientHeight || el.scrollTop>0;
                """), "Inspector cannot scroll"
                driver.execute_script(
                    "document.getElementById('infrastructure-atlas-inspector').scrollTop=0"
                )
                if driver.find_elements(By.CSS_SELECTOR, ".infrastructure-atlas-machine"):
                    click(".infrastructure-atlas-machine")
                    assert driver.find_element(
                        By.CSS_SELECTOR, ".infrastructure-guest-metrics"
                    ).is_displayed()
                    click('.infrastructure-atlas-close[aria-label="Back to guest fleet"]')
                    settle()
            click('.infrastructure-atlas-close[aria-label="Close details"]')
            settle()
        search = driver.find_element(By.ID, "infrastructure-atlas-search")
        search.send_keys("storage")
        wait.until(
            lambda d: 0 < len(d.find_elements(By.CSS_SELECTOR, ".infrastructure-atlas-node")) < 7
        )
        check("filtered", fitted=True)
        search.clear()
        search.send_keys("no-such-infrastructure-regression-check")
        wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR, ".infrastructure-atlas-node"))
        assert driver.find_element(By.CSS_SELECTOR, ".infrastructure-atlas-empty").is_displayed()
        search.clear()
        driver.execute_script(
            "document.getElementById('infrastructure-atlas-search').dispatchEvent(new Event('input'))"
        )
        wait.until(
            lambda d: len(d.find_elements(By.CSS_SELECTOR, ".infrastructure-atlas-node")) == 7
        )
        for width, height in [(1920, 1080), (1366, 768), (390, 844)]:
            resize(width, height)
            check(f"fit-{width}", fitted=True)
        before = camera()
        click('.infrastructure-atlas-zoom [aria-label="Zoom out"]')
        settle()
        assert camera()["scale"] < before["scale"], "Zoom out zoomed inward on mobile"
        check("mobile-zoom-out")
        click('.infrastructure-atlas-zoom [title="Fit inventory"]')
        settle()
        click('.infrastructure-atlas-node[data-node-id="pve"]')
        check("mobile-inspector")
        click('.infrastructure-atlas-close[aria-label="Close details"]')
        click(".infrastructure-atlas-back")
        wait.until(lambda d: d.execute_script("return app.currentPage==='range-hub'"))
        errors = [e for e in driver.get_log("browser") if e["level"] == "SEVERE"]
        assert not errors, errors
        print(f"PASS. Screenshots: {artifacts}")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
