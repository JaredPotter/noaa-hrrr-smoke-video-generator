// NOAA HRRR
// https://rapidrefresh.noaa.gov/hrrr/

// TODO: calculate CRF
// https://www.cnblogs.com/lakeone/p/5436481.html

const axios = require('axios');
const path = require('path');
const { spawnSync } = require('child_process');
const moment = require('moment');
const fs = require('fs-extra');

const firebaseAdmin = require('firebase-admin');
const utility = require('./utility');

const FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME =
  './noaa-hrrr-smoke-firebase-adminsdk-en9p6-8fe174d250.json';

const CODE_TO_TYPE = {
  sfc_smoke: 'near-surface-smoke',
  vi_smoke: 'vertically-integrated-smoke',
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

const firestore = firebaseAdmin.firestore();

const isDev = process.argv[2];
const arg3 = process.argv[3];
let forecastResumption = !isNaN(Number(arg3)) ? Number(arg3) : 0;

console.log('forecastResumption: ' + forecastResumption);

if (forecastResumption > 0) {
  forecastResumption = forecastResumption - 1;
}

const unitedStatesArea = {
  code: 'united-states',
  zoomLevel: 5,
  startingX: 4,
  startingY: 9,
  gridHeight: 5,
  gridWidth: 5,
};

const northWestArea = {
  code: 'north-west',
  zoomLevel: 7,
  startingX: 19,
  startingY: 44,
  gridHeight: 5,
  gridWidth: 5,
};

const utahArea = {
  code: 'utah',
  zoomLevel: 8,
  startingX: 46,
  startingY: 94,
  gridHeight: 5,
  gridWidth: 5,
};

const coloradoArea = {
  code: 'colorado',
  zoomLevel: 8,
  startingX: 50,
  startingY: 95,
  gridHeight: 5,
  gridWidth: 5,
};

const newMexicoArea = {
  code: 'new-mexico',
  zoomLevel: 8,
  startingX: 50,
  startingY: 99,
  gridHeight: 5,
  gridWidth: 5,
};

const AREAS = [
  utahArea,
  northWestArea,
  coloradoArea,
  newMexicoArea,
  unitedStatesArea,
];

if (!!isDev) {
  (async () => {
    const now = await getNearest48HourForecastStartTime();

    //adjust for correct numbering
    now.add(forecastResumption, 'hours');

    for (const area of AREAS) {
      console.log('Fetching area - ' + area.code);

      await fetchArea(
        area.zoomLevel,
        area.startingX,
        area.startingY,
        area.gridHeight,
        area.gridWidth,
        area.code,
        now
      );
    }

    console.log('DONE');
  })();
}

async function fetchArea(
  zoomLevel,
  startingX,
  startingY,
  gridHeight,
  gridWidth,
  areaCode,
  now
) {
  fs.ensureDirSync('area-base-maps');
  const filename = `./area-base-maps/${areaCode}.png`;
  const areaBaseMapExists = fs.existsSync(filename);

  if (!areaBaseMapExists) {
    console.log('Fetching base map for ' + areaCode);

    const tiles = await fetchBaseMapTiles(
      zoomLevel,
      startingX,
      startingY,
      gridHeight,
      gridWidth
    );

    const completeImageBuffer = await utility.stitchTileImages(
      tiles,
      256,
      1536,
      1536
    );

    fs.writeFileSync(filename, completeImageBuffer);
  }

  const startDateTimeMoment = moment(now);

  await fetchAndSaveNoaaHrrrOverlays(
    startDateTimeMoment,
    zoomLevel,
    startingX,
    startingY,
    gridHeight,
    gridWidth,
    areaCode
  );
}

async function is48HourForecastHour() {
  const modelRunNow = moment().utc();
  modelRunNow.set('minutes', 0);
  modelRunNow.set('seconds', 0);
  modelRunNow.add(-1, 'hour');
  // const modelRunNow = moment('2021-08-17T06:00:00Z').utc(); // dev only
  const modelrun = modelRunNow.format();
  const timeMoment = moment(modelRunNow);
  timeMoment.add(48, 'hours');

  const time = timeMoment.format();
  console.log(`UTC - ${timeMoment.format('MMM DD, hh:mma')}`);

  try {
    const url = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=25&y=25&z=5&time=${time}&modelrun=${modelrun}&level=0`;
    // const url = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=25&y=25&z=5&time=&modelrun=${modelrun}&level=0`;
    console.log('Checking if is 48 hour forecast time - ' + url);
    const response = await axios.get(url);

    if (response.status === 204) {
      return false;
    }
  } catch (error) {
    console.error(error);
    log(error);

    return false;
  }

  return true;
}

async function getNearest48HourForecastStartTime() {
  const modelRunNow = moment().utc();
  modelRunNow.set('minutes', 0);
  modelRunNow.set('seconds', 0);
  modelRunNow.add(-1, 'hour');

  let modelrun = modelRunNow.format();
  let isNearest = false;
  let timeMoment = moment(modelRunNow);

  while (!isNearest) {
    modelrun = modelRunNow.format();
    timeMoment = moment(modelRunNow);
    timeMoment.add(48, 'hours');
    time = timeMoment.format();

    const url = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=25&y=25&z=5&time=${time}&modelrun=${modelrun}&level=0`;
    console.log('Checking if is 48 hour forecast time - ' + url);
    const response = await axios.get(url);

    if (response.status === 204) {
      modelRunNow.add(-1, 'hour');
    } else if (response.status === 200) {
      isNearest = true;
      console.log(
        'Found nearest 48 hour forecast hour -> ' + modelRunNow.hours()
      );
    }
  }

  return modelRunNow;
}

async function fetchAndSaveNoaaHrrrOverlays(
  startDateTimeMoment,
  zoomLevel,
  startingX,
  startingY,
  gridHeight,
  gridWidth,
  areaCode
) {
  const modelrun = moment(startDateTimeMoment);
  const modelrunFormat = modelrun.format();
  const currentDateTime = moment(startDateTimeMoment);

  //adjust for correct numbering
  // currentDateTime.add(forecastResumption, 'hours');

  const typeCodes = Object.keys(CODE_TO_TYPE);
  const forecast = {
    areaCode,
    timestamp: moment(modelrunFormat).utc().unix(),
    near_surface_smoke_video_url_h264: '',
    near_surface_smoke_video_url_h265: '',
    near_surface_smoke_video_url_vp9: '',
    vertically_integrated_smoke_video_url_h264: '',
    vertically_integrated_smoke_video_url_h265: '',
    vertically_integrated_smoke_video_url_vp9: '',
  };

  for (let i = 0; i < typeCodes.length; i++) {
    const typeCode = typeCodes[i];

    const directory = `${CODE_TO_TYPE[typeCode]}/${modelrunFormat}/${areaCode}`;
    console.log(`Ensuring Directory Exists ${directory}`);
    fs.ensureDirSync(directory);

    const imageBufferLists = await fetchMapTiles(
      typeCode,
      zoomLevel,
      startingX,
      startingY,
      gridHeight,
      gridWidth,
      modelrunFormat
    );

    let smokeLayerFilenames = [];

    console.log('Snitching together tile images...');
    for (let i = 0; i < imageBufferLists.length; i++) {
      const imageBuffers = imageBufferLists[i];
      const completedImageBuffer = await utility.stitchTileImages(
        imageBuffers,
        256,
        1536,
        1536
      );
      const paddedId = String(i + 1).padStart(4, '0');
      const smokeLayerFilename = `smoke-overlay-${paddedId}.png`;

      console.log('Saving... ' + directory + '/' + smokeLayerFilename);

      smokeLayerFilenames.push(smokeLayerFilename);

      const fullFilePath = `./${directory}/${smokeLayerFilename}`;

      fs.writeFileSync(fullFilePath, completedImageBuffer);
    }

    // let smokeLayerFilenames = fs.readdirSync(directory); // dev only

    const changeTransparencyPromiseList = [];

    // Adjust overlay transparency to 75%
    console.log('Now changing transparency...');
    for (const smokeLayerFilename of smokeLayerFilenames) {
      const fullFilePath = `./${directory}/${smokeLayerFilename}`;

      changeTransparencyPromiseList.push(
        utility.changeTransparency(fullFilePath, 0.75)
      );
    }

    try {
      await Promise.all(changeTransparencyPromiseList);
    } catch (error) {
      // nothing
      log(error);
    }

    // Compose smoke layer with with base map tile
    let smokeOverlayPromiseList = [];

    console.log('Now overlaying base map with smoke layer');

    for (let i = 0; i < 48; i++) {
      const paddedId = String(i + 1).padStart(4, '0');
      const backgroundImagePath = `./area-base-maps/${areaCode}.png`;
      const inputFilename = `./${directory}/smoke-overlay-${paddedId}.png`;
      const outputFilename = `./${directory}/smoke-overlay+base-map_${paddedId}.png`;

      smokeOverlayPromiseList.push(
        utility.overlaySmokeWithBaseMap(
          backgroundImagePath,
          inputFilename,
          outputFilename
        )
      );
    }

    try {
      await Promise.all(smokeOverlayPromiseList);
    } catch (error) {
      // nothing
      log(error);
    }

    const annotationOverlayPromiseList = [];
    const time = moment(currentDateTime);

    console.log('Now overlaying annotation text...');
    for (let i = 0; i < 48; i++) {
      const overlayTypeSplit = CODE_TO_TYPE[typeCode].split('-');
      const overlayTypeResult = [];

      for (const word of overlayTypeSplit) {
        overlayTypeResult.push(capitalizeFirstLetter(word));
      }

      const overlayTypeLabel = overlayTypeResult.join(' ');
      const paddedId = String(i + 1).padStart(4, '0');
      const inputFilename = `./${directory}/smoke-overlay+base-map_${paddedId}.png`;
      const outputFilename = `./${directory}/final${paddedId}.png`;

      annotationOverlayPromiseList.push(
        utility.overlayAnnotationText(
          inputFilename,
          outputFilename,
          time,
          overlayTypeLabel
        )
      );

      time.add(1, 'hour');
    }

    try {
      await Promise.all(annotationOverlayPromiseList);
    } catch (error) {
      // nothing
      log(error);
    }

    const timestamp = modelrunFormat.replace(/\:/g, '_');

    const h264Crf = 32;
    const h265Crf = 32;
    const vp9Crf = 38;

    await generateVideos(timestamp, directory, h264Crf, h265Crf, vp9Crf);

    cleanupImageFiles(directory);

    const uploadUrls = await uploadVideos(
      directory,
      timestamp,
      h264Crf,
      h265Crf,
      vp9Crf,
      typeCode
    );

    switch (typeCode) {
      case 'sfc_smoke':
        forecast.near_surface_smoke_video_url_h264 =
          uploadUrls['near_surface_smoke_video_url_h264'];
        forecast.near_surface_smoke_video_url_h265 =
          uploadUrls['near_surface_smoke_video_url_h265'];
        forecast.near_surface_smoke_video_url_vp9 =
          uploadUrls['near_surface_smoke_video_url_vp9'];
        break;
      case 'vi_smoke':
        forecast.vertically_integrated_smoke_video_url_h264 =
          uploadUrls['vertically_integrated_smoke_video_url_h264'];
        forecast.vertically_integrated_smoke_video_url_h265 =
          uploadUrls['vertically_integrated_smoke_video_url_h265'];
        forecast.vertically_integrated_smoke_video_url_vp9 =
          uploadUrls['vertically_integrated_smoke_video_url_vp9'];
        break;
    }
  }

  if (
    !forecast.near_surface_smoke_video_url_h264 ||
    !forecast.near_surface_smoke_video_url_h265 ||
    !forecast.near_surface_smoke_video_url_vp9 ||
    !forecast.vertically_integrated_smoke_video_url_h264 ||
    !forecast.vertically_integrated_smoke_video_url_h265 ||
    !forecast.vertically_integrated_smoke_video_url_vp9
  ) {
    console.log('Failed to generate / upload videos. Now quitting.');
    return;
  }

  try {
    console.log('Adding Forecast to Firebase Firestore...');
    await firestore.collection('forecasts').add(forecast);
  } catch (error) {
    console.error(error);
    log(error);
    console.error('FAIL POSTing to API. Now quitting.');
    return;
  }

  console.log('FINISHED with all NOAA HRRR overlay fetching');
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
  modelrunTime // 2021-08-10T00:00:00Z FORMAT
) {
  let promiseList = [];
  const urlList = [];

  const currentDateTime = moment(modelrunTime).utc();

  for (let forecastHour = 0; forecastHour < 48; forecastHour++) {
    const time = currentDateTime.format();
    // const legendUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/legend/hrrr_smoke?var=${typeCode}&level=0`;
    // const legendImageBuffer = await axios(legendUrl);
    // https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=8&y=13&z=5&time=2021-08-10T22:00:00.000Z&modelrun=2021-08-10T05:00:00Z&level=0
    for (let x = startingX; x <= startingX + gridWidth; x++) {
      for (let y = startingY; y <= startingY + gridHeight; y++) {
        const imageUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=${typeCode}&x=${x}&y=${y}&z=${zoomLevel}&time=${time}&modelrun=${modelrunTime}&level=0`;

        urlList.push(imageUrl);
      }
    }

    currentDateTime.add(1, 'hour');
  }

  const totalRequestCount = urlList.length;

  console.log(totalRequestCount + ' requests');

  const requestsPerFetch = 180;
  let imageResponses = [];
  let offset = 0;

  while (imageResponses.length < totalRequestCount) {
    console.log('imageResponses.length: ' + imageResponses.length);
    const startIndex = offset
      ? offset * requestsPerFetch
      : offset * requestsPerFetch;
    const endingIndex = offset
      ? (offset + 1) * requestsPerFetch
      : (offset + 1) * requestsPerFetch;

    const requests = urlList.slice(startIndex, endingIndex);
    console.log(
      `Requesting ${startIndex} through ${endingIndex - 1} inclusive`
    );

    for (const request of requests) {
      promiseList.push(fetchTile(request));
    }

    try {
      console.log('awaiting requests to return...');
      const tempImageResponses = await Promise.all(promiseList);
      imageResponses.push(...tempImageResponses);

      await sleep(4000);
    } catch (error) {
      log(error);
      console.log('Too fast - take a little break');
      await sleep(15360);

      promiseList = [];

      console.log(
        'Re-attempting download of ' + requests.length + ' tile images'
      );

      continue;
    }

    offset = offset + 1;

    promiseList = [];
  }

  const finalImageResponses = [];
  const failedRequestUrls = [];

  for (const response of imageResponses) {
    if (response.status !== 200) {
      if (response.status === 204) {
        failedRequestUrls.push(response.config.url);
      }
    } else {
      finalImageResponses.push(response);
    }
  }

  if (failedRequestUrls.length !== 0) {
    let failCount = 0;
    let failedRequestCount = failedRequestUrls.length;

    let failedRequestIndex = 0;
    let currentFailedRequestCount = 0;

    while (failedRequestCount !== 0) {
      console.log('Outstanding Failed Requests ' + failedRequestCount);

      console.log(
        `Re-attempt failed requests ${failedRequestIndex} through ${
          failedRequestIndex + 180
        }`
      );

      let currentUrls = failedRequestUrls.slice(
        failedRequestIndex,
        failedRequestIndex + 180
      );

      currentFailedRequestCount = currentUrls.length;

      while (currentFailedRequestCount !== 0) {
        console.log('failCount: ' + failCount);

        if (failCount > 1000) {
          console.log('Fail count too great. Now exiting cronjob.');
          log(`Fail count too great. Now exiting cronjob.`);
          process.exit(1);
        }

        console.log(
          'Outstanding Current Failed Requests ' + currentFailedRequestCount
        );
        await sleep(500);

        promiseList = [];

        for (const url of currentUrls) {
          promiseList.push(fetchTile(url));
        }

        let tempImageResponses = [];

        try {
          tempImageResponses = await Promise.all(promiseList);
        } catch (error) {
          // nothing
          log(error);
        }

        currentUrls = [];

        debugger;

        for (const imageResponse of tempImageResponses) {
          if (imageResponse.status === 200) {
            finalImageResponses.push(imageResponse);
            currentFailedRequestCount--;
            failedRequestCount--;
          } else {
            currentUrls.push(imageResponse.config.url);
          }
        }

        failCount++;
      }

      failedRequestIndex = failedRequestIndex + 180;
    }
  }

  const imageBufferLists = [];

  // Image responses may return out of order.
  const tileImageMap = new Map();

  for (const response of finalImageResponses) {
    const url = response.config.url;
    const current_url = new URL(url);

    // get access to URLSearchParams object
    const search_params = current_url.searchParams;

    // get url parameters
    const x = Number(search_params.get('x'));
    const y = Number(search_params.get('y'));
    const time = search_params.get('time');

    const imageBuffer = Buffer.from(response.data, 'arraybuffer');

    if (tileImageMap.get(time)) {
      tileImageMap.get(time).push({
        time,
        buffer: imageBuffer,
        x: x - startingX,
        y: y - startingY,
      });
    } else {
      tileImageMap.set(time, [
        {
          time,
          buffer: imageBuffer,
          x: x - startingX,
          y: y - startingY,
        },
      ]);
    }
  }

  tileImageMap.forEach((listOfImageBufferObjects) => {
    imageBufferLists.push(listOfImageBufferObjects);
  });

  return imageBufferLists;
}

async function fetchTile(url) {
  return axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'Content-Type': 'image/png',
    },
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

  let promiseList = [];
  const urlList = [];

  for (let x = startingX; x <= startingX + gridWidth; x++) {
    for (let y = startingY; y <= startingY + gridHeight; y++) {
      const imageUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${zoomLevel}/${y}/${x}`;

      promiseList.push(fetchTile(imageUrl));
      urlList.push(imageUrl);
    }
  }

  const totalRequestCount = urlList.length;
  let successfullyCompletedRequestCount = 0;

  let imageResponses = [];

  while (successfullyCompletedRequestCount < totalRequestCount) {
    console.log('awaiting all tiles to return...');

    try {
      imageResponses = await Promise.all(promiseList);
    } catch (error) {
      console.log('Too fast - take a little break');
      await sleep(15360);

      promiseList = [];

      console.log(
        'Re-attempting download of ' + urlList.length + ' tile images'
      );

      for (const url of urlList) {
        promiseList.push(fetchTile(url));
      }

      continue;
    }

    promiseList = [];

    for (const response of imageResponses) {
      if (response.status !== 200) {
        if (imageResponses[0].status === 204) {
          debugger;
          console.log('Available forecast limit reached! Wrapping up.');

          return []; // return an empty image buffer array
        }
      } else {
        successfullyCompletedRequestCount++;
      }
    }
  }

  for (const response of imageResponses) {
    const url = response.config.url;
    const urlSplit = url.split('/');
    const x = Number(urlSplit[11]);
    const y = Number(urlSplit[10]);
    const imageBuffer = Buffer.from(response.data, 'arraybuffer');

    imageBufferList.push({
      buffer: imageBuffer,
      x: x - startingX,
      y: y - startingY,
    });
  }

  return imageBufferList;
}

async function generateVideos(timestamp, directory, h264Crf, h265Crf, vp9Crf) {
  const absolutePath = path.resolve('./' + directory);
  const outputVideoFilenameH264 = `${absolutePath}/${timestamp}_${h264Crf}_h264.mp4`;
  const outputVideoFilenameH265 = `${absolutePath}/${timestamp}_${h265Crf}_h265.mp4`;
  const outputVideoFilenameVp9Webm = `${absolutePath}/${timestamp}_${vp9Crf}_vp9.webm`;

  try {
    console.log('Generating Videos...');
    await generateMp4Video(
      absolutePath,
      outputVideoFilenameH264,
      'libx264',
      h264Crf
    );
    await generateMp4Video(
      absolutePath,
      outputVideoFilenameH265,
      'libx265',
      h265Crf
    );
    await generateVp9WebmVideo(
      absolutePath,
      outputVideoFilenameVp9Webm,
      vp9Crf
    );
  } catch (error) {
    console.error(error);
    log(error);
    console.error('Failed to generate video. Now exiting!');
  }
}

// https://trac.ffmpeg.org/wiki/Encode/H.264
// https://trac.ffmpeg.org/wiki/Encode/H.265
async function generateMp4Video(
  directory,
  outputFilename,
  encoder = 'libx264',
  crf = 25
) {
  const flags = [
    '-r', // framerate
    '4',
    '-f',
    'image2',
    '-s',
    '1536x1536',
    '-i',
    `${directory}/final%04d.png`,
    '-vcodec',
    encoder,
    '-preset',
    'slower',
    '-crf', // h.264 quality (0 and 51) - lower number is higher quality output
    crf,
    '-tune',
    'animation',
    '-pix_fmt',
    'yuv420p',
    '-y', // automatic overwrite
    '-movflags',
    'faststart',
  ];

  if (encoder === 'libx265') {
    flags.push('-tag:v', 'hvc1'); // Enable quicktime playback
  }

  flags.push(outputFilename);

  console.log(`ffmpeg ${flags.join(' ')}`);

  spawnSync('ffmpeg', flags);
}

// https://trac.ffmpeg.org/wiki/Encode/VP9
// https://developers.google.com/media/vp9/settings/vod/
async function generateVp9WebmVideo(directory, outputFilename, crf = 31) {
  const flags = [
    '-r', // framerate
    '4',
    // '-f',
    // 'image2',
    '-s',
    '1536x1536',
    '-i',
    `${directory}/final%04d.png`,
    '-vcodec',
    'libvpx-vp9',
    '-crf', // quality (0-63) - lower is higher quality
    crf,
    // '-deadline',
    // 'best',
    '-pix_fmt',
    'yuv420p',
    '-y', // automatic overwrite
    '-movflags',
    'faststart',
    outputFilename,
  ];

  console.log(`ffmpeg ${flags.join(' ')}`);

  spawnSync('ffmpeg', flags);
}

async function uploadVideos(
  directory,
  timestamp,
  h264Crf,
  h265Crf,
  vp9Crf,
  typeCode
) {
  const urls = {};

  try {
    console.log('Uploading Video...');

    const videoUrlH264 = (
      await uploadVideo(`${directory}/${timestamp}_${h264Crf}_h264.mp4`)
    )[0];
    const videoUrlH265 = (
      await uploadVideo(`${directory}/${timestamp}_${h265Crf}_h265.mp4`)
    )[0];
    const videoUrlVp9 = (
      await uploadVideo(`${directory}/${timestamp}_${vp9Crf}_vp9.webm`)
    )[0];

    switch (typeCode) {
      case 'sfc_smoke':
        urls['near_surface_smoke_video_url_h264'] = videoUrlH264;
        urls['near_surface_smoke_video_url_h265'] = videoUrlH265;
        urls['near_surface_smoke_video_url_vp9'] = videoUrlVp9;
        break;
      case 'vi_smoke':
        urls['vertically_integrated_smoke_video_url_h264'] = videoUrlH264;
        urls['vertically_integrated_smoke_video_url_h265'] = videoUrlH265;
        urls['vertically_integrated_smoke_video_url_vp9'] = videoUrlVp9;
        break;
    }
  } catch (error) {
    console.error(error);
    log(error);
    console.log('Failed to upload video. Now exiting!');
  }

  return urls;
}

async function uploadVideo(fileName) {
  const fileResultArray = await bucket.upload(fileName, {
    destination: fileName,
  });
  await fileResultArray[0].setMetadata({
    cacheControl: 'public, max-age=31536000, immutable',
    setMetadata: {
      cacheControl: 'public, max-age=31536000, immutable',
    },
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

function log(message) {
  fs.ensureFileSync('./log.txt');
  fs.appendFileSync('./log.txt', message + '\n');
}

(async () => {
  if (!isDev) {
    console.log('CRON - NOAA HRRR SMOKE FETCHER STARTED');
    console.log('TIME TO RUN');

    const now = moment().utc();
    now.set('minutes', 0);
    now.set('seconds', 0);
    now.add(-1, 'hour');
    // const now = moment("2021-08-29T12:00:00Z").utc(); // dev only.

    // Check if on the 6 hour 48-hour forecast
    let is48HourForecast = await is48HourForecastHour();

    if (is48HourForecast) {
      console.log('Time to fetch forecast!');
    }

    while (!is48HourForecast) {
      console.log('Sleeping for 15 seconds...');
      await sleep(15000);

      is48HourForecast = await is48HourForecastHour();
    }

    if (!is48HourForecast) {
      console.log('Current Hour is not 48 hour forecast. Quitting now.');
      return;
    }

    //adjust for correct numbering
    now.add(forecastResumption, 'hours');

    for (const area of AREAS) {
      console.log('Fetching area - ' + area.code);

      await fetchArea(
        area.zoomLevel,
        area.startingX,
        area.startingY,
        area.gridHeight,
        area.gridWidth,
        area.code,
        now
      );
    }
  }
})();

async function cleanupImageFiles(directory) {
  const regex = /.*\.png/;

  const filenames = fs.readdirSync(directory);
  const imageFilenames = filenames.filter((filename) => regex.test(filename));

  imageFilenames.map((filename) => fs.unlinkSync(`${directory}/${filename}`));
}
