/**
 * Basin Hydroclimate Time Series
 * ------------------------------
 * Monthly water-balance and climate variables averaged over river basins,
 * in one tidy table (one row per basin and month):
 *
 *   precip_mm      precipitation               ERA5-Land monthly
 *   evap_mm        total evaporation           ERA5-Land monthly
 *   et_modis_mm    actual evapotranspiration   MODIS MOD16A2GF (500 m)
 *   t2m_c          2 m air temperature         ERA5-Land monthly
 *   lst_day_c      daytime land surface temp.  MODIS MOD11A2 (1 km)
 *   tws_cm         terrestrial water storage   GRACE / GRACE-FO JPL mascons
 *                  anomaly (equivalent water height, cm)
 *
 * Basins come from HydroBASINS (pick them with points) or from your own
 * FeatureCollection with a "name" property.
 *
 * How to run
 *   Paste into https://code.earthengine.google.com, edit CONFIG, press Run,
 *   then start the CSV export from the Tasks tab.
 *
 * Author: Parisa Abbasalizadehrezaei · https://risarezaei.github.io
 * License: MIT
 */

// =============================== CONFIG ===================================
var CONFIG = {
  // Basins as [name, lon, lat]: the HydroBASINS polygon that contains each
  // point is used. Example: the Lake Urmia basin.
  basinPoints: [['Lake_Urmia', 45.60, 37.60]],
  hydrobasinsLevel: 4,              // 1 (continental) ... 12 (small catchments)

  // Or use your own polygons (must have a "name" property); null = off.
  customBasins: null,               // e.g. ee.FeatureCollection('users/you/basins')

  start: '2003-01-01',
  end: '2025-01-01',

  exportTable: true,
  driveFolder: 'earthengine',
  filePrefix: 'basin_hydroclimate'
};
// ==========================================================================

var start = ee.Date(CONFIG.start), end = ee.Date(CONFIG.end);

// ---- Basins --------------------------------------------------------------
var basins;
if (CONFIG.customBasins) {
  basins = ee.FeatureCollection(CONFIG.customBasins).select(['name']);
} else {
  var hb = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_' + CONFIG.hydrobasinsLevel);
  basins = ee.FeatureCollection(CONFIG.basinPoints.map(function (b) {
    var poly = hb.filterBounds(ee.Geometry.Point([b[1], b[2]])).first();
    return ee.Feature(poly).select(['HYBAS_ID', 'SUB_AREA']).set('name', b[0]);
  }));
}
var region = basins.geometry().bounds();

// ---- Datasets (each mapped to one monthly band) --------------------------
var era5 = ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR').filterBounds(region);
var mod16 = ee.ImageCollection('MODIS/061/MOD16A2GF').select('ET').filterBounds(region);
var mod11 = ee.ImageCollection('MODIS/061/MOD11A2').select('LST_Day_1km').filterBounds(region);
var grace = ee.ImageCollection('NASA/GRACE/MASS_GRIDS_V04/MASCON').select('lwe_thickness');

// Returns a 1-band image for the month, or a masked band if no data exist.
function orEmpty(col, fn, name) {
  return ee.Image(ee.Algorithms.If(col.size().gt(0), fn(col),
    ee.Image.constant(0).updateMask(0))).rename(name).toFloat();
}

function month(m0) {
  var m1 = m0.advance(1, 'month');
  var e = era5.filterDate(m0, m1);
  var img = ee.Image.cat([
    orEmpty(e, function (c) { return c.first().select('total_precipitation_sum').multiply(1000); }, 'precip_mm'),
    orEmpty(e, function (c) { return c.first().select('total_evaporation_sum').multiply(-1000); }, 'evap_mm'),
    orEmpty(e, function (c) { return c.first().select('temperature_2m').subtract(273.15); }, 't2m_c'),
    // MOD16 ET is an 8-day sum (kg/m2 = mm, scale 0.1): mean daily rate x days in month
    orEmpty(mod16.filterDate(m0, m1), function (c) {
      return c.mean().multiply(0.1).divide(8).multiply(m1.difference(m0, 'day'));
    }, 'et_modis_mm'),
    orEmpty(mod11.filterDate(m0, m1), function (c) {
      return c.mean().multiply(0.02).subtract(273.15);
    }, 'lst_day_c'),
    orEmpty(grace.filterDate(m0, m1), function (c) { return c.mean(); }, 'tws_cm')
  ]);
  return img.set({month: m0.format('YYYY-MM'), 'system:time_start': m0.millis()});
}

var BANDS = ['precip_mm', 'evap_mm', 'et_modis_mm', 't2m_c', 'lst_day_c', 'tws_cm'];
var nMonths = end.difference(start, 'month').round();

var table = ee.FeatureCollection(ee.List.sequence(0, nMonths.subtract(1)).map(function (i) {
  var img = month(start.advance(i, 'month'));
  // 5 km is enough for basin means; GRACE mascons are much coarser anyway.
  return img.reduceRegions({collection: basins, reducer: ee.Reducer.mean(),
                            scale: 5000, tileScale: 4})
    .map(function (f) {
      return f.setGeometry(null).set({month: img.get('month'), t: img.get('system:time_start')});
    });
})).flatten();

// ---- Charts for each basin -----------------------------------------------
Map.addLayer(basins.style({color: '4fd1c5', fillColor: '4fd1c522', width: 2}), {}, 'Basins');
Map.centerObject(basins, 7);

var names = CONFIG.customBasins ? null : CONFIG.basinPoints.map(function (b) { return b[0]; });
(names || ['all basins']).forEach(function (n) {
  var rows = names ? table.filter(ee.Filter.eq('name', n)) : table;
  print(ui.Chart.feature.byFeature(rows, 't', ['precip_mm', 'et_modis_mm', 'evap_mm'])
    .setChartType('LineChart').setOptions({
      title: n + ': precipitation and evapotranspiration (mm/month)',
      hAxis: {format: 'yyyy'}, vAxis: {title: 'mm per month'}, lineWidth: 1.5,
      colors: ['1e88e5', '2e7d32', 'a5d6a7']
    }));
  print(ui.Chart.feature.byFeature(rows, 't', ['tws_cm'])
    .setChartType('AreaChart').setOptions({
      title: n + ': GRACE terrestrial water storage anomaly (cm)',
      hAxis: {format: 'yyyy'}, vAxis: {title: 'cm'}, colors: ['6a1b9a'],
      legend: {position: 'none'}, interpolateNulls: false
    }));
  print(ui.Chart.feature.byFeature(rows, 't', ['t2m_c', 'lst_day_c'])
    .setChartType('LineChart').setOptions({
      title: n + ': air and land surface temperature (°C)',
      hAxis: {format: 'yyyy'}, vAxis: {title: '°C'}, lineWidth: 1.5,
      colors: ['ef6c00', 'c62828']
    }));
});

print('Table preview', table.limit(12));

if (CONFIG.exportTable) {
  Export.table.toDrive({
    collection: table, description: CONFIG.filePrefix,
    folder: CONFIG.driveFolder, fileFormat: 'CSV',
    selectors: ['name', 'month'].concat(BANDS)
  });
}
