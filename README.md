Setup (tested on Mac, un-tested on PC)

1. `npm install`

2. `brew install ffmpeg`

3. `brew install imagemagick`

4. Setup Firebase Project and add JSON service file to root of directory

Normal Usage (Node Cron Schedule)

`node index.js`

Dev Usage (Immediately-invoked Function Expressions)

`node index.js dev`

TODO

- create `temp` folder where uuid png temp files are saved/deleted from. Add temp folder to gitignore
- add smoke key / legend to each image
- delete / cleanup utilized png images after successful upload
- make faster...
- Add 2 pass flags to ffmpeg encoding
- test / calculate "best" and comparable parameters for h.264, h.265, and vp9.
- hunt down bug where some overlay png images aren't getting their transparancy reduced
