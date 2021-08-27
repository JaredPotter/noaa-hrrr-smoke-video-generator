// NOAA HRRR
// https://rapidrefresh.noaa.gov/hrrr/

// TODO: calculate CRF
// https://www.cnblogs.com/lakeone/p/5436481.html

const axios = require("axios");
const crossSpawn = require("cross-spawn");
const path = require("path");
const { spawnSync } = require("child_process");
const crossSpawnSync = crossSpawn.sync;
const moment = require("moment");
const cron = require("node-cron");
const fs = require("fs-extra");
const blend = require("@mapbox/blend");
const firebaseAdmin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

const FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME =
  "./noaa-hrrr-smoke-firebase-adminsdk-en9p6-8fe174d250.json";

const CODE_TO_TYPE = {
  sfc_smoke: "near-surface-smoke",
  vi_smoke: "vertically-integrated-smoke",
};

if (!fs.existsSync(FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME)) {
  console.log("FIREBASE SERVICE ACCOUNT FILE MISSING!");
  console.log("NOW EXITING!");
  return;
}

const firebaseAdminServiceAccount = require(FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE_NAME);

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(firebaseAdminServiceAccount),
});

const bucket = firebaseAdmin
  .storage()
  .bucket("gs://noaa-hrrr-smoke.appspot.com");

const isDev = process.argv[2];
const arg3 = process.argv[3];
let forecastResumption = !isNaN(Number(arg3)) ? Number(arg3) : 0;

console.log("forecastResumption: " + forecastResumption);

if (forecastResumption > 0) {
  forecastResumption = forecastResumption - 1;
}

const northWestArea = {
  code: "north-west",
  zoomLevel: 7,
  startingX: 19,
  startingY: 44,
  gridHeight: 5,
  gridWidth: 5,
};

const utahArea = {
  code: "utah",
  zoomLevel: 8,
  startingX: 46,
  startingY: 94,
  gridHeight: 5,
  gridWidth: 5,
};

const coloradoArea = {
  code: "colorado",
  zoomLevel: 8,
  startingX: 50,
  startingY: 95,
  gridHeight: 5,
  gridWidth: 5,
};

const AREAS = [utahArea, coloradoArea];

if (!!isDev) {
  (async () => {
    const is48HourForecast = await is48HourForecastHour();

    if (!is48HourForecast) {
      console.log("Current Hour is not 48 hour forecast. Quitting now.");
      return;
    }

    for (const area of AREAS) {
      await fetchArea(
        area.zoomLevel,
        area.startingX,
        area.startingY,
        area.gridHeight,
        area.gridWidth,
        area.code
      );
    }

    console.log("DONE");
  })();
}

async function fetchArea(
  zoomLevel,
  startingX,
  startingY,
  gridHeight,
  gridWidth,
  areaCode
) {
  fs.ensureDirSync("area-base-maps");
  const filename = `./area-base-maps/${areaCode}.png`;
  const areaBaseMapExists = fs.existsSync(filename);

  if (!areaBaseMapExists) {
    console.log("Fetching base map for " + areaCode);

    const tiles = await fetchBaseMapTiles(
      area.zoomLevel,
      area.startingX,
      area.startingY,
      area.gridHeight,
      area.gridWidth
    );

    const completeImageBuffer = await stitchTileImages(tiles, 256, 1536, 1536);

    fs.writeFileSync(filename, completeImageBuffer);
  }

  // Check if on the 6 hour 48-hour forecast
  const now = moment().utc();
  now.set("minutes", 0);
  now.set("seconds", 0);
  now.add(-1, "hour");
  // const now = moment('2021-08-26T00:00:00Z').utc(); // dev only
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
  modelRunNow.set("minutes", 0);
  modelRunNow.set("seconds", 0);
  modelRunNow.add(-1, "hour");
  // const modelRunNow = moment('2021-08-17T06:00:00Z').utc(); // dev only
  const modelrun = modelRunNow.format();
  const timeMoment = moment(modelRunNow);
  timeMoment.add(48, "hours");

  const time = timeMoment.format();
  console.log(`UTC - ${timeMoment.format("MMM DD, hh:mma")}`);

  try {
    const url = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=25&y=25&z=5&time=${time}&modelrun=${modelrun}&level=0`;
    console.log("Checking if is 48 hour forecast time - " + url);
    const response = await axios.get(url);

    if (response.status === 204) {
      return false;
    }
  } catch (error) {
    console.error(error);

    return false;
  }

  return true;
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
  let availableForecastsLimitReached = false;
  const modelrun = moment(startDateTimeMoment);
  const modelrunFormat = modelrun.format();
  const currentDateTime = moment(startDateTimeMoment);

  //adjust for correct numbering
  currentDateTime.add(forecastResumption, "hours");

  const typeCodes = Object.keys(CODE_TO_TYPE);

  for (
    let forecastHour = forecastResumption;
    forecastHour < 48;
    forecastHour++
  ) {
    const time = currentDateTime.format();

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
        modelrunFormat
      );

      if (tiles.length === 0) {
        availableForecastsLimitReached = true;
        break;
      }

      console.log("Snitching together tile images...");
      const completeImageBuffer = await stitchTileImages(
        tiles,
        256,
        1536,
        1536
      );

      const directory = `${CODE_TO_TYPE[typeCode]}/${modelrunFormat}/${areaCode}`;
      fs.ensureDirSync(directory);
      const paddedId = String(forecastHour + 1).padStart(4, "0");
      const filename = `overlay-${time}-${paddedId}.png`;

      console.log("Saving... " + directory + "/" + filename);

      const layerFilename = `${directory}/${filename}`;

      fs.writeFileSync(layerFilename, completeImageBuffer);

      // Adjust overlay transparency to 75%
      console.log("Now changing transparency...");
      await changeTransparency(layerFilename, 0.75);

      // Composite with base map tile
      console.log("Now overlaying...");
      const overlayTypeSplit = CODE_TO_TYPE[typeCode].split("-");
      const overlayTypeResult = [];

      for (const word of overlayTypeSplit) {
        overlayTypeResult.push(capitalizeFirstLetter(word));
      }

      const overlayTypeLabel = overlayTypeResult.join(" ");

      await overlay(
        `./area-base-maps/${areaCode}.png`,
        layerFilename,
        `${directory}/final${paddedId}.png`,
        time,
        overlayTypeLabel
      );

      console.log("done with image: " + paddedId);
    }

    if (availableForecastsLimitReached) {
      break;
    }

    currentDateTime.add(1, "hour");
  }

  const forecast = {
    areaCode,
    timestamp: moment(modelrunFormat).utc().unix(),
    near_surface_smoke_video_url_h264: "",
    near_surface_smoke_video_url_h265: "",
    near_surface_smoke_video_url_vp9: "",
    vertically_integrated_smoke_video_url_h264: "",
    vertically_integrated_smoke_video_url_h265: "",
    vertically_integrated_smoke_video_url_vp9: "",
  };

  for (let i = 0; i < typeCodes.length; i++) {
    const typeCode = typeCodes[i];
    const timestamp = modelrunFormat.replace(/\:/g, "_");
    const directory = `${CODE_TO_TYPE[typeCode]}/${modelrunFormat}/${areaCode}`;
    const absolutePath = path.resolve("./" + directory);
    const outputVideoFilenameH264 = `${absolutePath}/${timestamp}_h264.mp4`;
    const outputVideoFilenameH265 = `${absolutePath}/${timestamp}_h265.mp4`;
    const outputVideoFilenameVp9Webm = `${absolutePath}/${timestamp}_vp9.webm`;

    try {
      console.log("Generating Videos...");
      await generateMp4Video(
        absolutePath,
        outputVideoFilenameH264,
        "libx264",
        26
      );
      await generateMp4Video(
        absolutePath,
        outputVideoFilenameH265,
        "libx265",
        31
      );
      await generateVp9WebmVideo(absolutePath, outputVideoFilenameVp9Webm, 34);
    } catch (error) {
      console.error(error);
      console.error("Failed to generate video. Now exiting!");
      continue;
    }

    try {
      console.log("Uploading Video...");

      const videoUrlH264 = (
        await uploadVideo(`${directory}/${timestamp}_h264.mp4`)
      )[0];
      const videoUrlH265 = (
        await uploadVideo(`${directory}/${timestamp}_h265.mp4`)
      )[0];
      const videoUrlVp9 = (
        await uploadVideo(`${directory}/${timestamp}_vp9.webm`)
      )[0];

      switch (typeCode) {
        case "sfc_smoke":
          forecast.near_surface_smoke_video_url_h264 = videoUrlH264;
          forecast.near_surface_smoke_video_url_h265 = videoUrlH265;
          forecast.near_surface_smoke_video_url_vp9 = videoUrlVp9;
          break;
        case "vi_smoke":
          forecast.vertically_integrated_smoke_video_url_h264 = videoUrlH264;
          forecast.vertically_integrated_smoke_video_url_h265 = videoUrlH265;
          forecast.vertically_integrated_smoke_video_url_vp9 = videoUrlVp9;
          break;
      }
    } catch (error) {
      console.error(error);
      console.log("Failed to upload video. Now exiting!");
      continue;
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
    console.log("Failed to generate / upload videos. Now quitting.");
    return;
  }

  try {
    console.log("POSTing to Laravel API!");
    await axios.post("https://noaa-hrrr-smoke-api.herokuapp.com/forecasts", {
      data: forecast,
    });
  } catch (error) {
    console.error(error);
    console.error("FAIL POSTing to Laravel API. Now quitting.");
    return;
  }

  console.log("FINISHED with all NOAA HRRR overlay fetching");
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
        format: "png",
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
  const urlList = [];

  // const legendUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/legend/hrrr_smoke?var=${typeCode}&level=0`;
  // const legendImageBuffer = await axios(legendUrl);
  // https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=sfc_smoke&x=8&y=13&z=5&time=2021-08-10T22:00:00.000Z&modelrun=2021-08-10T05:00:00Z&level=0
  for (let x = startingX; x <= startingX + gridWidth; x++) {
    for (let y = startingY; y <= startingY + gridHeight; y++) {
      const imageUrl = `https://hwp-viz.gsd.esrl.noaa.gov/wmts/image/hrrr_smoke?var=${typeCode}&x=${x}&y=${y}&z=${zoomLevel}&time=${time}&modelrun=${modelrunTime}&level=0`;
      // console.log(`Fetching ${imageUrl}`);
      promiseList.push(fetchTile(imageUrl));
      urlList.push(imageUrl);
    }
  }

  const totalRequestCount = urlList.length;
  let successfullyCompletedRequestCount = 0;

  let imageResponses = [];

  while (successfullyCompletedRequestCount < totalRequestCount) {
    console.log("awaiting all tiles to return...");

    try {
      imageResponses = await Promise.all(promiseList);
    } catch (error) {
      console.log("Too fast - take a little break");
      await sleep(15360);

      promiseList = [];

      console.log(
        "Re-attempting download of " + urlList.length + " tile images"
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
          console.log("Available forecast limit reached! Wrapping up.");

          return []; // return an empty image buffer array
        }
      } else {
        successfullyCompletedRequestCount++;
      }
    }
  }

  for (const response of imageResponses) {
    const url = response.config.url;
    const current_url = new URL(url);

    // get access to URLSearchParams object
    const search_params = current_url.searchParams;

    // get url parameters
    const x = Number(search_params.get("x"));
    const y = Number(search_params.get("y"));

    const imageBuffer = Buffer.from(response.data, "binary");

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
    responseType: "arraybuffer",
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
    console.log("awaiting all tiles to return...");

    try {
      imageResponses = await Promise.all(promiseList);
    } catch (error) {
      console.log("Too fast - take a little break");
      await sleep(15360);

      promiseList = [];

      console.log(
        "Re-attempting download of " + urlList.length + " tile images"
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
          console.log("Available forecast limit reached! Wrapping up.");

          return []; // return an empty image buffer array
        }
      } else {
        successfullyCompletedRequestCount++;
      }
    }
  }

  for (const response of imageResponses) {
    const url = response.config.url;
    const urlSplit = url.split("/");
    const x = Number(urlSplit[11]);
    const y = Number(urlSplit[10]);
    const imageBuffer = Buffer.from(response.data, "binary");

    imageBufferList.push({
      buffer: imageBuffer,
      x: x - startingX,
      y: y - startingY,
    });
  }

  return imageBufferList;
}

// convert 0001.png -channel A -evaluate Multiply 0.75 +channel 0001-new.png
async function changeTransparency(imagePath, opacity = 0.75) {
  spawnSync("convert", [
    imagePath,
    "-channel",
    "A",
    "-evaluate",
    "Multiply",
    opacity,
    "+channel",
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

  spawnSync("convert", [
    backgroundImagePath,
    overlayImagePath,
    "-gravity",
    "center",
    "-background",
    "None",
    "-layers",
    "Flatten",
    tempFilename,
  ]);

  const timestampMoment = moment.utc(timestamp);
  console.log("UTC TIME: " + timestampMoment.format("MMM DD YYYY hh:mm A"));
  const readableTimestampMoment = timestampMoment.local();
  const dayOfWeek = readableTimestampMoment.format("dddd");
  const readableTimestamp = readableTimestampMoment.format(
    "MMM DD YYYY hh:mm A"
  );
  console.log("LOCAL TIME: " + readableTimestamp);

  // Add annotation for date time
  spawnSync("convert", [
    tempFilename,
    "-background",
    "Khaki",
    "-font",
    "Times-New-Roman",
    "-pointsize",
    "36",
    "-gravity",
    "north",
    "-annotate",
    "+10+10",
    `${overlayTypeLabel} - Mountain Time - ${dayOfWeek}, ${readableTimestamp}`,
    outputFilename,
  ]);

  fs.unlinkSync(tempFilename);
}

// fast start
// ffmpeg -i origin.mp4 -acodec copy -vcodec copy -movflags faststart fast_start.mp4
// ffmpeg -r 8 -f image2 -s 1536x1536 -i ./near-surface-smoke/2021-08-10T05_00_00Z/final%04d.png -vcodec libx264 -crf 15 -pix_fmt yuv420p -movflags faststart ./near-surface-smoke/2021-08-10T05_00_00Z/near-surface-smoke-2021-08-10T05_00_00Z.mp4
// ffmpeg -r 8 -f image2 -s 1536x1536 -i final%04d.png -vcodec libx264 -crf 15 -pix_fmt yuv420p -movflags faststart near-surface-smoke-2021-08-10T05_00_00Z.mp4
// https://trac.ffmpeg.org/wiki/Encode/H.265
async function generateMp4Video(
  directory,
  outputFilename,
  encoder = "libx264",
  crf = 25
) {
  const flags = [
    "-r", // framerate
    "4",
    "-f",
    "image2",
    "-s",
    "1536x1536",
    "-i",
    `${directory}/final%04d.png`,
    "-vcodec",
    encoder,
    "-crf", // h.264 quality (0 and 51) - lower number is higher quality output
    crf,
    "-pix_fmt",
    "yuv420p",
    "-y", // automatic overwrite
    "-movflags",
    "faststart",
  ];

  if (encoder === "libx265") {
    flags.push("-tag:v", "hvc1"); // Enable quicktime playback
  }

  flags.push(outputFilename);

  console.log(`ffmpeg ${flags.join(" ")}`);

  spawnSync("ffmpeg", flags);
}

// https://trac.ffmpeg.org/wiki/Encode/VP9
async function generateVp9WebmVideo(directory, outputFilename, crf = 31) {
  const flags = [
    "-r", // framerate
    "4",
    // '-f',
    // 'image2',
    "-s",
    "1536x1536",
    "-i",
    `${directory}/final%04d.png`,
    "-vcodec",
    "libvpx-vp9",
    "-crf", // quality (0-63) - lower is higher quality
    crf,
    // '-pass',
    // 2,
    "-pix_fmt",
    "yuv420p",
    "-y", // automatic overwrite
    "-movflags",
    "faststart",
    outputFilename,
  ];

  console.log(`ffmpeg ${flags.join(" ")}`);

  spawnSync("ffmpeg", flags);
}

async function uploadVideo(fileName) {
  const fileResultArray = await bucket.upload(fileName, {
    destination: fileName,
  });
  await fileResultArray[0].setMetadata({
    cacheControl: "public, max-age=31536000, immutable",
    setMetadata: {
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const downloadUrl = await fileResultArray[0].getSignedUrl({
    action: "read",
    expires: "03-09-2491",
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
  console.log("CRON - NOAA HRRR SMOKE FETCHER STARTED");

  cron.schedule("58 1,7,13,19 * * *", async () => {
    console.log("TIME TO RUN");

    // Check if on the 6 hour 48-hour forecast
    const is48HourForecast = await is48HourForecastHour();

    if (!is48HourForecast) {
      console.log("Current Hour is not 48 hour forecast. Quitting now.");
      return;
    }

    const now = moment().utc();
    now.set("minutes", 0);
    now.set("seconds", 0);
    now.add(-1, "hour");

    // const now = moment('2021-08-17T06:00:00Z').utc(); // dev only

    //adjust for correct numbering
    now.add(forecastResumption, "hours");

    for (const area of AREAS) {
      await fetchArea(
        area.zoomLevel,
        area.startingX,
        area.startingY,
        area.gridHeight,
        area.gridWidth,
        area.code
      );
    }
  });
}
