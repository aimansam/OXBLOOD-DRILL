/* Page entry points stay separate from the global shell controller. */
(function attachPageModules(root) {
  const handlers = {
    'range-hub': 'loadRangeHub',
    'my-mission': 'loadMyMission',
    dashboard: 'loadDashboard',
    drills: 'loadDrills',
    scenarios: 'loadScenariosPage',
    teams: 'loadTeamsPage',
    infrastructure: 'loadInfrastructurePage',
    scoreboard: 'loadScoreboardPage',
    reports: 'loadReports',
    settings: 'loadSettings',
    setup: 'loadSetup',
  };

  root.DividePageModules = {
    async load(ui, page) {
      const method = handlers[page];
      if (method && typeof ui[method] === 'function') return ui[method]();
      return undefined;
    },
  };
})(window);
