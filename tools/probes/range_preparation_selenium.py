"""Read-only portal checks. Lifecycle states are rendered locally, not provisioned.

Requires DIVIDE_UI_TEST_TOKEN, Selenium and Chrome. Never calls prepare/start/stop.
"""

import os
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def main():
    url = os.environ.get("DIVIDE_UI_TEST_URL", "http://127.0.0.1:5000").rstrip("/")
    output = Path("/tmp/range-preparation-check")
    output.mkdir(exist_ok=True)
    options = webdriver.ChromeOptions()
    for arg in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage"]:
        options.add_argument(arg)
    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 30)
    try:
        driver.set_window_size(1440, 1000)
        driver.get(url + "/login")
        driver.execute_script(
            "localStorage.setItem('divide_token',arguments[0])", os.environ["DIVIDE_UI_TEST_TOKEN"]
        )
        driver.get(url + "/drill/")
        wait.until(lambda d: d.execute_script("return !!window.app && !!app.user"))
        driver.execute_script("app.loadPage('scenarios')")
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".scenario-atlas-node"))
        result = driver.execute_async_script("""
          const done=arguments[0];
          const scenario=app._scenarioPageCatalog.find(s=>s.name==='enterprise-file-breach');
          API.get('/drills/scenario-preflight/'+scenario.id).then(done).catch(e=>done({error:e.message}));
        """)
        assert "checks" in result, result
        assert any(c["id"] == "memory" for c in result["checks"])
        print(
            "PASS live preflight: " + str({c["id"]: c["ready"] for c in result["checks"]}),
            flush=True,
        )
        driver.execute_script("app.loadPage('drills')")
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, ".drill-catalog-run"))
        drill_id = driver.find_element(By.CSS_SELECTOR, ".drill-catalog-run").get_attribute(
            "data-node-id"
        )
        driver.execute_async_script(
            "app.playDrill(Number(arguments[0])).then(arguments[1])", drill_id
        )
        driver.execute_script("app.stopDrillPolling()")
        # Exercise the real renderer with local state fixtures; no write requests.
        for phase, label, disabled in [
            (None, "Prepare range", False),
            ("starting", "Preparing...", True),
            ("validating", "Preparing...", True),
            ("started", "Start exercise", False),
            ("validation_failed", "Start exercise", False),
        ]:
            driver.execute_script(
                """
              app.applyDrillStateControls({status:'scheduled',scenario_id:1,
                environment_config:{provision_status:arguments[0]}});
            """,
                phase,
            )
            button = driver.find_element(By.ID, "btn-start-drill")
            assert button.is_displayed()
            assert button.text == label, button.text
            assert button.is_enabled() != disabled
        driver.execute_script("app.applyDrillStateControls(app.currentDrill)")
        driver.execute_async_script("app.showRangeReadiness().then(arguments[0])")
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, "#range-readiness-content li"))
        for width, height in [(1440, 1000), (390, 844)]:
            driver.execute_cdp_cmd(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )
            time.sleep(0.5)
            bounds = driver.execute_script("""
              const d=document.getElementById('range-readiness-dialog'), r=d.getBoundingClientRect();
              return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
                      fits:d.scrollWidth<=d.clientWidth};
            """)
            assert bounds["inside"] and bounds["fits"], bounds
            driver.save_screenshot(str(output / f"readiness-{width}.png"))
            print(f"PASS readiness dialog {width}", flush=True)
        driver.find_element(
            By.CSS_SELECTOR, '#range-readiness-dialog [aria-label="Close readiness checks"]'
        ).click()
        assert not driver.find_element(By.ID, "range-readiness-dialog").is_displayed()
        print("PASS preparation control states and dialog close", flush=True)
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
