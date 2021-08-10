const axios = require('axios');
const crossSpawn = require('cross-spawn');
const moment = require('moment');
const cron = require('node-cron');
const fs = require('fs-extra');
const blend = require('@mapbox/blend');

const isDev = process.argv[2];

if (!!isDev) {
  (async () => {
    const zoomLevel = 7;
    const startingX = 19;
    const startingY = 44;
    const gridHeight = 5;
    const gridWidth = 6;

    await fetchAndSaveNoaaHrrrOverlays(
      zoomLevel,
      startingX,
      startingY,
      gridHeight,
      gridWidth
    );

    console.log('DONE');
  })();
}

async function fetchAndSaveNoaaHrrrOverlays(
  zoomLevel,
  startingX,
  startingY,
  gridHeight,
  gridWidth
) {
  const codeToType = {
    // sfc_smoke: 'near-surface-smoke',
    // vi_smoke: 'vertically-integrated-smoke',
    sfc_visibility: 'surface-visibility',
  };

  const typeCodes = Object.keys(codeToType);

  const now = moment().utc();
  now.set('minutes', 0);
  now.set('seconds', 0);
  now.add(-2, 'hour');
  const modelrun = now.format();
  // return

  for (let forecastHour = 0; forecastHour < 48; forecastHour++) {
    const time = now.format();

    for (let i = 0; i < typeCodes.length; i++) {
      const typeCode = typeCodes[i];
      const tiles = await fetchMapTiles(
        typeCode,
        zoomLevel,
        startingX,
        startingY,
        gridHeight,
        gridWidth,
        time,
        modelrun
      );
      // debugger;
      const blendeOverlayBuffer = await blendImages(tiles, 256, 1500, 1500);

      const directory = `${codeToType[typeCode]}/${modelrun}`;
      fs.ensureDirSync(directory);
      const filename = `overlay-${time}-${String(forecastHour + 1).padStart(
        4,
        '0'
      )}.png`;

      console.log('Saving... ' + directory + '/' + filename);

      fs.writeFileSync(`${directory}/${filename}`, blendeOverlayBuffer);

      await sleep(5000);
    }

    now.add(1, 'hour');
  }

  console.log('FINISHED with all NOAA HRRR overlay fetching');
}

async function blendImages(imageBufferList, tileSize, height, width) {
  for (const imageBufferObject of imageBufferList) {
    imageBufferObject.x *= tileSize;
    imageBufferObject.y *= tileSize;
  }

  return new Promise((resolve, reject) => {
    blend(
      imageBufferList,
      {
        format: 'png',
        quality: 256,
        height,
        width,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        // result contains the blended result image compressed as PNG.
        resolve(result);
        return;
      }
    );
  });
}

//https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=24&y=49&z=7&time=2021-08-10T00:00:00.000Z&modelrun=2021-08-10T00:00:00Z&level=0
//https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=vi_smoke&x=24&y=49&z=7&time=2021-08-10T01:00:00.000Z&modelrun=2021-08-10T00:00:00Z&level=0
//https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_visibility&x=19&y=48&z=7&time=2021-08-10T01:00:00.000Z&modelrun=2021-08-10T00:00:00Z&level=0
async function fetchMapTiles(
  typeCode,
  zoomLevel,
  startingX,
  startingY,
  gridHeight,
  gridWidth,
  time, // 2021-08-10T00:00:00Z FORMAT
  modelrunTime // 2021-08-10T00:00:00Z FORMAT
) {
  const imageBufferList = [];

  const promiseList = [];

  // const legendUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/legend/hrrr_smoke?var=${typeCode}&level=0`;
  // const legendImageBuffer = await axios(legendUrl);

  for (let x = startingX; x <= startingX + gridWidth; x++) {
    for (let y = startingY; y <= startingY + gridHeight; y++) {
      const imageUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=${typeCode}&x=${x}&y=${y}&z=${zoomLevel}&time=${time}&modelrun=${modelrunTime}&level=0`;
      // console.log(`Fetching ${imageUrl}`);
      promiseList.push(
        axios.get(imageUrl, {
          responseType: 'arraybuffer',
        })
      );
    }
  }

  const imageResponses = await Promise.all(promiseList);

  for (const response of imageResponses) {
    const url = response.config.url;
    const current_url = new URL(url);

    // get access to URLSearchParams object
    const search_params = current_url.searchParams;

    // get url parameters
    const x = Number(search_params.get('x'));
    const y = Number(search_params.get('y'));

    const imageBuffer = Buffer.from(response.data, 'binary');

    imageBufferList.push({
      buffer: imageBuffer,
      x: x - startingX,
      y: y - startingY,
    });
  }

  return imageBufferList;
}

async function fetchBaseMapTiles(
  zoomLevel,
  startingX,
  startingY,
  gridHeight,
  gridWidth
) {
  const imageBufferList = [];

  for (let x = startingX; x <= startingX + gridWidth; x++) {
    for (let y = startingY; y <= startingY + gridHeight; y++) {
      const imageUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${zoomLevel}/${y}/${x}`;

      console.log(`Fetching ${imageUrl}`);
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
      });

      const imageBuffer = Buffer.from(response.data, 'binary');

      imageBufferList.push({
        buffer: imageBuffer,
        x: x - startingX,
        y: y - startingY,
      });
    }
  }

  return imageBufferList;
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

if (!isDev) {
  console.log('NOAA HRRR SMOKE FETCHER STARTED');

  cron.schedule('5 * * * *', async () => {
    // X:05 - every 5th minute of the hour
    console.log('TIME TO RUN');

    const zoomLevel = 7;
    const startingX = 19;
    const startingY = 44;
    const gridHeight = 5;
    const gridWidth = 6;

    await fetchAndSaveNoaaHrrrOverlays(
      zoomLevel,
      startingX,
      startingY,
      gridHeight,
      gridWidth
    );
  });
}
