Setup (tested on Mac, un-tested on PC)

1. `npm install`

2. `brew install ffmpeg`

3. `brew install imagemagick`

4. Add crontab w/ `crontab -e` inside the Mac Terminal
   Inside of default VIM, hit `i` to enable editing/insert

   Add Cron Job

   ```
   SHELL=/bin/sh
   PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

   58 1,7,13,19 * * * /Users/private-mac-server/code/noaa-hrrr-smoke-video-generator/index.sh
   ```

   Run `which node` to get path Enable full disk access to `cron` Hit ESC key, then `:wq!` and Return key
   This will run 1 hour 58 minutes after the 12 hour UTC clock +6 hour intervals - just when NOAA makes the full 48-hour forecast available.

5. Setup Firebase Project and add JSON service file to root of directory

Normal Usage (Node Cron Schedule)

`node index.js`

Dev Usage (Immediately-invoked Function Expressions)

`node index.js dev`

TODO

- add smoke key / legend to each image
