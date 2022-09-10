const moment = require('moment');
const { execFile } = require('child_process');
const blend = require('@mapbox/blend');
const path = require('path');

async function stitchTileImages(imageBufferList, tileSize, height, width) {
  for (const imageBufferObject of imageBufferList) {
    imageBufferObject.x *= tileSize;
    imageBufferObject.y *= tileSize;
  }

  return new Promise((resolve, reject) => {
    // https://www.npmjs.com/package/@mapbox/blend
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
          console.error(error);
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

// convert 0001.png -alpha set -background none -channel A -evaluate multiply 0.5 +channel 0001-new.png
function changeTransparency(imagePath, opacity = 0.75) {
  const absoluteFilePath = path.resolve(imagePath);

  return execPromise('convert', [
    absoluteFilePath,
    '-alpha',
    'set',
    '-background',
    'none',
    '-channel',
    'A',
    '-evaluate',
    'multiply',
    opacity,
    '+channel',
    absoluteFilePath,
  ]);
}

// convert 0001.png 0002.png -gravity center -background None -layers Flatten composite.png
function overlaySmokeWithBaseMap(
  backgroundImagePath,
  overlayImagePath,
  outputFilename
) {
  return execPromise('convert', [
    backgroundImagePath,
    overlayImagePath,
    '-gravity',
    'center',
    '-background',
    'None',
    '-layers',
    'Flatten',
    outputFilename,
  ]);
}

function overlayAnnotationText(
  imagePath,
  outputFilename,
  timestamp,
  overlayTypeLabel
) {
  const timestampMoment = moment.utc(timestamp);
  // console.log('UTC TIME: ' + timestampMoment.format('MMM DD YYYY hh:mm A'));
  const readableTimestampMoment = timestampMoment.local();
  const dayOfWeek = readableTimestampMoment.format('dddd');
  const readableTimestamp = readableTimestampMoment.format(
    'MMM DD YYYY hh:mm A'
  );

  return execPromise('convert', [
    imagePath,
    '-background',
    'Khaki',
    '-font',
    'Times-New-Roman',
    '-pointsize',
    '48',
    '-weight',
    'Bold',
    '-gravity',
    'north',
    '-annotate',
    '+10+10',
    `${overlayTypeLabel} - Mountain Time - ${dayOfWeek}, ${readableTimestamp}`,
    outputFilename,
  ]);
}

async function execPromise(command, flags) {
  const child = execFile(command, flags);

  return new Promise((resolve, reject) => {
    child.addListener('error', reject);
    child.addListener('exit', resolve);
  });
}

module.exports = {
  stitchTileImages,
  changeTransparency,
  overlaySmokeWithBaseMap,
  overlayAnnotationText,
};
