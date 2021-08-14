// NOAA HRRR
// https://rapidrefresh.noaa.gov/hrrr/

const axios = require('axios');
const crossSpawn = require('cross-spawn');
const path = require('path');
const { spawnSync } = require('child_process');
const crossSpawnSync = crossSpawn.sync;
const moment = require('moment');
const cron = require('node-cron');
const fs = require('fs-extra');
const blend = require('@mapbox/blend');
const firebaseAdmin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME =
  './noaa-hrrr-smoke-firebase-adminsdk-en9p6-8fe174d250.json';

const CODE_TO_TYPE = {
  sfc_smoke: 'near-surface-smoke',
  vi_smoke: 'vertically-integrated-smoke',
  sfc_visibility: 'surface-visibility',
};

if (!fs.existsSync(FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME)) {
  console.log('FIREBASE SERVICE ACCOUNT FILE MISSING!');
  console.log('NOW EXITING!');
  return;
}

const firebaseAdminServiceAccount = require(FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME);

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(firebaseAdminServiceAccount),
});

const bucket = firebaseAdmin
  .storage()
  .bucket('gs://noaa-hrrr-smoke.appspot.com');

const BASE_MAP_FILE_PATH = './base-map.png';

const isDev = process.argv[2];
const arg3 = process.argv[3];
let forecastResumption = !isNaN(Number(arg3)) ? Number(arg3) : 0;

console.log('forecastResumption: ' + forecastResumption);

if (forecastResumption > 0) {
  forecastResumption = forecastResumption - 1;
}

if (!!isDev) {
  (async () => {
    const zoomLevel = 7;
    const startingX = 19;
    const startingY = 44;
    const gridHeight = 5;
    const gridWidth = 6;

    // await changeTransparency('./0002-copy.png', 0.75);
    // await overlay('./0001.png', './0002.png', './composite0001.png');

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
  let availableForecastsLimitReached = false;

  const typeCodes = Object.keys(CODE_TO_TYPE);

  const now = moment().utc();
  now.set('minutes', 0);
  now.set('seconds', 0);
  now.add(-1, 'hour');
  // const now = moment('2021-08-13T18:00:00Z').utc(); // dev only
  const modelrun = now.format();

  //adjust for correct numbering
  now.add(forecastResumption, 'hours');

  for (
    let forecastHour = forecastResumption;
    forecastHour < 48;
    // forecastHour < 4;
    forecastHour++
  ) {
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

      if (tiles.length === 0) {
        availableForecastsLimitReached = true;
        break;
      }

      console.log('Snitching together tile images...');
      const completeImageBuffer = await stitchTileImages(
        tiles,
        256,
        1500,
        1500
      );

      const directory = `${CODE_TO_TYPE[typeCode]}/${modelrun}`;
      fs.ensureDirSync(directory);
      const paddedId = String(forecastHour + 1).padStart(4, '0');
      const filename = `overlay-${time}-${paddedId}.png`;

      console.log('Saving... ' + directory + '/' + filename);

      const layerFilename = `${directory}/${filename}`;

      fs.writeFileSync(layerFilename, completeImageBuffer);

      // Adjust overlay transparency to 75%
      console.log('Now changing transparency...');
      await changeTransparency(layerFilename, 0.75);

      // Composite with base map tile
      console.log('Now overlaying...');
      const overlayTypeSplit = CODE_TO_TYPE[typeCode].split('-');
      const overlayTypeResult = [];

      for (const word of overlayTypeSplit) {
        overlayTypeResult.push(capitalizeFirstLetter(word));
      }

      const overlayTypeLabel = overlayTypeResult.join(' ');

      await overlay(
        BASE_MAP_FILE_PATH,
        layerFilename,
        `${directory}/final${paddedId}.png`,
        time,
        overlayTypeLabel
      );

      console.log('done with image: ' + paddedId);
      // await sleep(10000);
    }

    if (availableForecastsLimitReached) {
      break;
    }

    now.add(1, 'hour');
  }

  const forecast = {
    timestamp: moment(modelrun).utc().unix(),
    near_surface_smoke_video_url: '',
    vertically_integrated_smoke_video_url: '',
    surface_visibility_video_url: '',
  };

  for (let i = 0; i < typeCodes.length; i++) {
    const typeCode = typeCodes[i];
    const timestamp = modelrun.replaceAll(':', '_');
    const directory = `./${CODE_TO_TYPE[typeCode]}/${modelrun}`;
    const absolutePath = path.resolve(directory);
    const outputVideoFilename = `${absolutePath}/${timestamp}.mp4`;

    try {
      await generateMp4Video(absolutePath, outputVideoFilename, 15);
    } catch (error) {
      console.error(error);
      console.error('Failed to generate video. Now exiting!');
      continue;
    }

    try {
      const uploadFileName = `${CODE_TO_TYPE[typeCode]}/${modelrun}/${timestamp}.mp4`;
      const videoUrl = (await uploadVideo(uploadFileName))[0];

      switch (typeCode) {
        case 'sfc_smoke':
          forecast.near_surface_smoke_video_url = videoUrl;
          break;
        case 'vi_smoke':
          forecast.vertically_integrated_smoke_video_url = videoUrl;
          break;
        case 'sfc_visibility':
          forecast.surface_visibility_video_url = videoUrl;
          break;
      }

      console.log(videoUrl);
    } catch (error) {
      console.error(error);
      console.log('Failed to upload video. Now exiting!');
      continue;
    }
  }
  debugger;
  try {
    console.log('POSTing to Laravel API!');
    await axios.post('https://noaa-hrrr-smoke-api.herokuapp.com/forecasts', {
      data: forecast,
    });
  } catch (error) {
    console.error(error);
    console.error('FAIL POSTing to Laravel API. Now quitting.');
    return;
  }

  console.log('FINISHED with all NOAA HRRR overlay fetching');
}

async function stitchTileImages(imageBufferList, tileSize, height, width) {
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

  let promiseList = [];

  // const legendUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/legend/hrrr_smoke?var=${typeCode}&level=0`;
  // const legendImageBuffer = await axios(legendUrl);
  // https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=8&y=13&z=5&time=2021-08-10T22:00:00.000Z&modelrun=2021-08-10T05:00:00Z&level=0
  for (let x = startingX; x <= startingX + gridWidth; x++) {
    for (let y = startingY; y <= startingY + gridHeight; y++) {
      const imageUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=${typeCode}&x=${x}&y=${y}&z=${zoomLevel}&time=${time}&modelrun=${modelrunTime}&level=0`;
      // console.log(`Fetching ${imageUrl}`);
      promiseList.push(fetchTile(imageUrl));
    }
  }

  const totalRequestCount = gridWidth * gridHeight;
  let successfullyCompletedRequestCount = 0;

  let imageResponses = [];

  while (successfullyCompletedRequestCount < totalRequestCount) {
    console.log('awaiting all tiles to return...');
    imageResponses = await Promise.all(promiseList);

    promiseList = [];

    const reAttemptUrlList = [];

    for (const response of imageResponses) {
      if (response.status !== 200) {
        if (imageResponses[0].status === 204) {
          console.log('Available forecast limit reached! Wrapping up.');

          return []; // return an empty image buffer array
        }

        const imageUrl = response.config.url;

        reAttemptUrlList.push(imageUrl);
      } else {
        successfullyCompletedRequestCount++;
      }
    }

    if (reAttemptUrlList.length > 0) {
      console.log('We hit the limit. Now sleeping...');
      debugger;
      await sleep(5000);

      for (const imageUrl of reAttemptUrlList) {
        promiseList.push(fetchTile(imageUrl));
      }
    }
  }

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

async function fetchTile(url) {
  return axios.get(url, {
    responseType: 'arraybuffer',
  });
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

// convert 0001.png -channel A -evaluate Multiply 0.75 +channel 0001-new.png
async function changeTransparency(imagePath, opacity = 0.75) {
  spawnSync('convert', [
    imagePath,
    '-channel',
    'A',
    '-evaluate',
    'Multiply',
    opacity,
    '+channel',
    imagePath,
  ]);
}

// convert 0001.png 0002.png -gravity center -background None -layers Flatten composite.png
async function overlay(
  backgroundImagePath,
  overlayImagePath,
  outputFilename,
  timestamp,
  overlayTypeLabel
) {
  const tempUuid = uuidv4();
  const tempFilename = `${tempUuid}.png`;

  spawnSync('convert', [
    backgroundImagePath,
    overlayImagePath,
    '-gravity',
    'center',
    '-background',
    'None',
    '-layers',
    'Flatten',
    tempFilename,
  ]);

  const timestampMoment = moment.utc(timestamp);
  console.log('UTC TIME: ' + timestampMoment.format('MMM DD YYYY hh:mm A'));
  const readableTimestampMoment = timestampMoment.local();
  const dayOfWeek = readableTimestampMoment.format('dddd');
  const readableTimestamp = readableTimestampMoment.format(
    'MMM DD YYYY hh:mm A'
  );
  console.log('LOCAL TIME: ' + readableTimestamp);

  // Add annotation for date time
  spawnSync('convert', [
    tempFilename,
    '-background',
    'Khaki',
    '-font',
    'Times-New-Roman',
    '-pointsize',
    '36',
    '-gravity',
    'north',
    '-annotate',
    '+10+10',
    `${overlayTypeLabel} - Mountain Time - ${dayOfWeek}, ${readableTimestamp}`,
    outputFilename,
  ]);

  fs.unlinkSync(tempFilename);
}
// ffmpeg -r 8 -f image2 -s 1500x1500 -i ./near-surface-smoke/2021-08-10T05_00_00Z/final%04d.png -vcodec libx264 -crf 15 -pix_fmt yuv420p -movflags faststart ./near-surface-smoke/2021-08-10T05_00_00Z/near-surface-smoke-2021-08-10T05_00_00Z.mp4
// ffmpeg -r 8 -f image2 -s 1500x1500 -i final%04d.png -vcodec libx264 -crf 15 -pix_fmt yuv420p -movflags faststart near-surface-smoke-2021-08-10T05_00_00Z.mp4
async function generateMp4Video(directory, outputFilename, crf = 25) {
  const flags = [
    '-r', // framerate
    '8',
    '-f',
    'image2',
    '-s',
    '1500x1500',
    '-i',
    `${directory}/final%04d.png`,
    '-vcodec',
    'libx264',
    '-crf',
    crf,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'faststart',
    outputFilename,
  ];

  console.log(`ffmpeg ${flags.join(' ')}`);

  spawnSync('ffmpeg', flags);

  //ffmpeg -r 60 -f image2 -s 1920x1080 -i pic%04d.png -vcodec libx264 -crf 25  -pix_fmt yuv420p test.mp4

  // fast start
  // ffmpeg -i origin.mp4 -acodec copy -vcodec copy -movflags faststart fast_start.mp4
}

async function uploadVideo(fileName) {
  const fileResultArray = await bucket.upload(`./${fileName}`, {
    destination: fileName,
  });

  const downloadUrl = await fileResultArray[0].getSignedUrl({
    action: 'read',
    expires: '03-09-2491',
  });

  return downloadUrl;
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

if (!isDev) {
  console.log('NOAA HRRR SMOKE FETCHER STARTED');

  cron.schedule('15 1,7,15,19 * * *', async () => {
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
