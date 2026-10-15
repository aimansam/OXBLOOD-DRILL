/* Page entry points stay separate from the global shell controller. */
(function attachPageModules(root) {
  const handlers = {
    'range-hub': 'loadRangeHub',
    dashboard: 'loadDashboard',
    drills: 'loadDrills',
    scenarios: 'loadScenariosPage',
    infrastructure: 'loadInfrastructurePage',
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
