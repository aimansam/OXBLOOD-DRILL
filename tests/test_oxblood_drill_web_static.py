"""Static regression checks for the vanilla OxBlood drill UI."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTAL = ROOT / "apps" / "portal" / "app"
API = ROOT / "apps" / "api" / "app"


def _read(relpath: str) -> str:
    return (PORTAL / relpath).read_text()


def _prototype_methods(js: str) -> set[str]:
    return set(re.findall(r"^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{", js, flags=re.MULTILINE))


def test_drill_inline_handlers_have_loaded_methods() -> None:
    markup = _read("pages/drills.html") + _read("app.js")
    scripts = (
        _read("app.js")
        + _read("ui-drills.js")
        + _read("ui-advanced.js")
        + _read("ui-utils.js")
        + _read("threat-map.js")
    )
    methods = _prototype_methods(scripts)
    handlers = set(re.findall(r"app\.([A-Za-z_]\w*)\(", markup))

    missing = sorted(name for name in handlers if name not in methods)
    assert missing == []


def test_setup_inline_handlers_have_loaded_methods() -> None:
    markup = _read("pages/setup.html")
    scripts = _read("app.js") + _read("ui-utils.js")
    methods = _prototype_methods(scripts)
    handlers = set(re.findall(r"app\.([A-Za-z_]\w*)\(", markup))

    missing = sorted(name for name in handlers if name not in methods)
    assert missing == []


def test_active_drill_sections_are_loaded() -> None:
    drills_js = _read("ui-drills.js")

    for loader in [
        "loadDrillStats",
        "loadDrillObjectives",
        "loadDrillFlags",
        "loadDrillParticipantsExtended",
        "loadDrillScores",
        "loadDrillFirstBloods",
        "loadDrillSubmissions",
        "loadDrillTeams",
        "loadDrillHintsWithUnlock",
        "loadDrillProgress",
        "loadDrillAnnouncementsRich",
        "loadDrillScenarios",
        "loadDrillReports",
    ]:
        assert f"this.{loader}(drillId" in drills_js


def test_drill_polling_stops_when_leaving_drills_page() -> None:
    app_js = _read("app.js")

    assert "this.currentPage === 'drills' && page !== 'drills'" in app_js
    assert "this.stopDrillPolling()" in app_js


def test_markdown_links_reject_unsafe_schemes() -> None:
    utils_js = _read("ui-utils.js")

    assert 'rel="noopener noreferrer"' in utils_js
    assert "https?:\\/\\/" in utils_js
    assert "mailto:" in utils_js


def test_api_client_surfaces_fastapi_error_detail() -> None:
    api_js = _read("api.js")

    assert "_errorFromResponse" in api_js
    assert "body.detail" in api_js
    assert "throw await this._errorFromResponse(response)" in api_js


def test_participants_endpoint_returns_display_names() -> None:
    router = "\n".join(p.read_text() for p in sorted((API / "routers" / "drills_v2").glob("*.py")))

    assert re.search(r"from app\.db\.models import [^\n]*\bUser\b", router)
    assert '"sub": users_by_id[p.user_id].sub' in router
    assert '"username": users_by_id[p.user_id].sub' in router


def test_setup_covers_template_and_scenario_network_readiness() -> None:
    setup_html = _read("pages/setup.html")
    app_js = _read("app.js")
    api_js = _read("api.js")

    assert "setup-tabs" in setup_html
    assert "setup-tab-infra" in setup_html
    assert "setup-tab-users" in setup_html
    assert "setup-tab-system" in setup_html
    assert "switchSetupTab" in app_js
    assert "setup-template" in setup_html
    assert "setup-scenario-network" in setup_html
    assert "loadSetupTemplate" in app_js
    assert "loadSetupScenarioNetwork" in app_js
    assert "/admin/drill-template-status" in api_js
    assert "/admin/pve-sdn-status" in api_js
    assert "/admin/pve-setup-bridges" in api_js
    assert "/scenarios?include_run_count=true" in api_js


def test_setup_exposes_guarded_unused_vm_cleanup() -> None:
    setup_html = _read("pages/setup.html")
    app_js = _read("app.js")
    api_js = _read("api.js")

    assert "setup-orphans" in setup_html
    assert "Remove unused VMs" in app_js
    assert "loadSetupOrphans" in app_js
    assert "cleanupSetupOrphans" in app_js
    assert "/admin/assets/orphans" in api_js
    assert "/admin/assets/cleanup" in api_js


def test_create_drill_modal_previews_scenario_runtime_readiness() -> None:
    drills_html = _read("pages/drills.html")
    app_js = _read("app.js")
    api_js = _read("api.js")

    assert "drill-scenario-readiness" in app_js
    assert "updateDrillScenarioReadiness" in app_js
    assert "_scenarioTemplateRefs" in app_js
    assert "_scenarioNetworkRefs" in app_js
    assert "Scenario not start-ready" in app_js
    assert "/proxmox/templates" in api_js
    assert "/admin/expected-bridges" in api_js


def test_create_drill_uses_wizard_catalog_and_provision_monitor() -> None:
    drills_html = _read("pages/drills.html")
    app_js = _read("app.js")
    styles = _read("styles.css")

    for marker in [
        "create-drill-modal",
        "create-drill-wizard-body",
        "create-step-1",
        "create-step-4",
        "create-wizard-schedule",
        "create-wizard-start",
        "create-wizard-retry",
        "create-wizard-open",
    ]:
        assert marker in drills_html
    assert "_scenarioImageSlot" in app_js
    assert "shiftCreateScenario" in app_js
    assert "_handleCreateWizardKeydown" in app_js
    assert "scenario-browser" in app_js
    assert "scenario-browser single" in app_js
    assert "createWizardLaunch" in app_js
    assert "_pollCreatedDrillProvision" in app_js
    assert "retryCreatedDrillProvision" in app_js
    assert "provisionReady" in app_js
    assert "Provisioning is running in the background" in app_js
    assert ".scenario-media-slot" in styles
    assert "scenario-card-large" in styles
    assert "grid-template-columns: 56px minmax(0, 760px) 56px" in styles
    assert ".scenario-card" in styles
    assert ".provision-monitor" in styles


def test_active_drill_view_uses_full_screen_threat_map() -> None:
    drills_html = _read("pages/drills.html")
    threat_map_js = _read("threat-map.js")
    styles = _read("styles.css")

    for marker in [
        "threat-command-hud",
        "threat-map-root",
        "threat-map-metrics",
        "threat-map-pause",
        "threat-map-resume",
    ]:
        assert marker in drills_html
    assert "renderThreatMap" in threat_map_js
    assert "threat-map-mode" in styles
    assert ".threat-command-hud" in styles


def test_operator_threat_map_is_full_page_workspace() -> None:
    drills_html = _read("pages/drills.html")
    drills_js = _read("ui-drills.js")
    styles = _read("styles.css")

    assert 'id="threat-map-root"' in drills_html
    assert "renderThreatMap(drill)" in drills_js
    assert "body.threat-map-mode .threat-active-workspace" in styles
    assert ".threat-command-shell .threat-map-layout" in styles


def test_threat_map_visual_surfaces_are_present() -> None:
    drills_html = _read("pages/drills.html")
    app_js = _read("app.js")
    drills_js = _read("ui-drills.js")
    advanced_js = _read("ui-advanced.js")
    styles = _read("styles.css")

    assert "threat-map-root" in drills_html
    assert "renderThreatMap" in drills_js
    assert "inspectThreatNode" in app_js
    assert "inspectThreatEdge" in app_js
    assert "topology-hero" in app_js
    assert "_topologyDeviceMeta" in app_js
    assert "_topologyDeviceIcon" in app_js
    assert "_topologySvgIcon" in app_js
    assert "_topologySvgNode" in app_js
    assert "_topologyGraphNode" in app_js
    assert "packet-device-" in app_js
    assert "network-wire" in app_js
    assert "topology-svg" in app_js
    assert "report-visual-summary" in advanced_js
    assert "_topologyLiveAsset" in app_js
    assert "scenario-media-filled" in app_js
    assert "role-action-grid" in drills_js
    assert "report-chart-grid" in advanced_js
    assert "provision-recovery" in app_js
    for marker in [
        ".topology-hero",
        ".packet-topology",
        ".network-canvas",
        ".network-wire",
        ".topology-svg",
        ".topology-svg-device",
        ".topology-svg-zone",
        ".packet-device-router",
        ".packet-os-badge",
        ".threat-map-shell",
        ".threat-map-inspector",
        ".threat-map-playing",
        ".threat-map-intro",
        ".threat-command-shell",
    ]:
        assert marker in styles


def test_active_drill_workspace_keeps_map_and_hud_together() -> None:
    drills_html = _read("pages/drills.html")

    active_open = drills_html.index('id="drills-active-view"')
    hud = drills_html.index('class="threat-command-hud"')
    map_root = drills_html.index('id="threat-map-root"')
    active_close = drills_html.index('</div>\n\n  <dialog id="range-readiness-dialog"')

    assert active_open < hud < map_root < active_close


def test_drill_export_supports_real_csv() -> None:
    advanced_js = _read("ui-advanced.js")

    assert "_rowsToCsv" in advanced_js
    assert "drill-${drillId}-export.csv" in advanced_js
    assert "'text/csv;charset=utf-8'" in advanced_js
    assert "drill-${drillId}-export.json" in advanced_js


def test_linked_scenario_ui_shows_catalog_identity() -> None:
    drills_js = _read("ui-drills.js")

    assert "s.title || s.name" in drills_js
    assert "this._readinessPill(!!s.is_active)" in drills_js


def test_active_drill_page_is_state_aware() -> None:
    drills_html = _read("pages/drills.html")
    app_js = _read("app.js")
    drills_js = _read("ui-drills.js")

    for marker in [
        "btn-start-drill",
        "threat-map-pause",
        "threat-map-resume",
        "range-readiness-dialog",
        "threat-map-title",
        "threat-map-clock",
    ]:
        assert marker in drills_html
    assert "applyDrillStateControls" in drills_js
    assert "renderThreatMap(drill)" in drills_js
    assert "loadOperatorLiveFlow" in drills_js
    assert "getElementById('threat-map-pause')" in _read("threat-map.js")
    assert "Provision run #" in app_js


def test_participant_drill_workspace_is_focused() -> None:
    app_js = _read("app.js")
    drills_js = _read("ui-drills.js")
    styles = _read("styles.css")

    assert (
        "participantHidden = ['scoring', 'access', 'people', 'comms', 'scenario', 'reports']"
        in app_js
    )
    assert "activeView.dataset.activeTab = selected" in app_js
    assert "participant-workspace" in drills_js
    assert "#drills-active-view.participant-workspace .ops-rail" in styles
    assert "#drills-active-view.participant-workspace .drill-tabs" in styles
    assert (
        "#drills-active-view.operator-workspace:not(.drill-tab-active-operate) .ops-rail" in styles
    )


def test_scenarios_and_topology_page_are_wired() -> None:
    index_html = _read("index.html")
    scenarios_html = _read("pages/scenarios.html")
    app_js = _read("app.js")
    styles = _read("styles.css")

    header_html = _read("components/header.html")
    assert "Hub" in header_html
    assert 'data-component="header"' in index_html
    assert "scenario-atlas" in scenarios_html
    assert "loadScenariosPage" in app_js
    assert ".scenario-atlas-node" in styles
    assert ".scenario-atlas-links" in styles


def test_account_sound_toggle_is_wired() -> None:
    settings_html = _read("pages/settings.html")
    app_js = _read("app.js")
    utils_js = _read("ui-utils.js")

    assert "data-sound-toggle" in settings_html
    assert "updateSoundControls" in app_js
    assert "playSound" in utils_js
    assert "oxblood.sound" in utils_js


def test_drill_briefing_uses_linked_catalog_scenario() -> None:
    drills_html = _read("pages/drills.html")
    drills_js = _read("ui-drills.js")

    assert "threat-map-root" in drills_html
    assert "_catalogScenarioById" in drills_js
    assert "spec.objectives" in drills_js
    assert "spec.assets" in drills_js
    assert "spec.networks" in drills_js


def test_drill_polling_does_not_clear_active_timer() -> None:
    drills_js = _read("ui-drills.js")
    polling = drills_js[
        drills_js.index("\n  _startDrillPolling") : drills_js.index("async loadDrillStats")
    ]

    assert "clearInterval(this._drillPollInterval)" in polling
    assert "['completed', 'cancelled', 'stopped', 'failed']" in polling
    assert "this.stopDrillPolling()" in polling
