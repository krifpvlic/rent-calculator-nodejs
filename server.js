const express = require('express')
const axios = require('axios')
const dotenv = require('dotenv')
const scrapeLogic = require('./scrapeLogic.js')
const calculateRentPrice = require('./backend/functions/calculateRentPrice.js')
const trackFunctionCalls = require('./backend/functions/statistics.js')
const path = require('path')
const cron = require('node-cron')
const cors = require('cors')

const app = express()
dotenv.config()

app.use(express.json())

let requestQueue = [] // Queue to store incoming requests
let processing = false // Flag to track if a request is being processed

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript'); // Set the MIME type explicitly
  res.send(`
    self.addEventListener('install', (event) => {
      console.log('Service Worker installing...');
      event.waitUntil(self.skipWaiting());
    });

    self.addEventListener('activate', (event) => {
      console.log('Service Worker activated');
      event.waitUntil(self.clients.claim());
    });

    self.addEventListener('fetch', (event) => {
      console.log('Service Worker fetching:', event.request.url);
      event.respondWith(fetch(event.request));
    });

    // Additional caching, background sync, or push notification code can go here
  `);
});

const processQueue = async () => {
  if (processing || requestQueue.length === 0) return // If already processing or queue is empty, return

  processing = true
  const { req, res } = requestQueue.shift() // Get the next request

  try {
    const {
      postcode,
      houseNumber,
      houseLetter,
      houseAddition,
      numberOfRooms,
      outdoorSpaceValue,
      kitchen,
      bathroom,
      periodSignedContract
    } = req.body

    console.log("User entered address: " + postcode + " " + houseNumber + " " + houseLetter, houseAddition)

    let addressString = `${postcode} ${houseNumber}`
    if (houseLetter) addressString += ` ${houseLetter}`
    if (houseAddition) addressString += ` ${houseAddition}`

    const bagUrl = new URL('https://api.bag.kadaster.nl/lvbag/viewerbevragingen/v2/adressen')
    bagUrl.searchParams.set('expand', 'true')
    bagUrl.searchParams.set('postcode', postcode)
    bagUrl.searchParams.set('huisnummer', houseNumber)
    if (houseLetter) bagUrl.searchParams.set('huisletter', houseLetter)
    if (houseAddition) bagUrl.searchParams.set('huisnummertoevoeging', houseAddition)

    const bagConfig = {
      headers: {
        accept: 'application/hal+json',
        'X-Api-Key': process.env.BAG_API_KEY,
      },
    }

    const energyLabelUrl = new URL('https://public.ep-online.nl/api/v5/PandEnergielabel/Adres')
    energyLabelUrl.searchParams.set('postcode', postcode)
    energyLabelUrl.searchParams.set('huisnummer', houseNumber)
    if (houseLetter) energyLabelUrl.searchParams.set('huisletter', houseLetter)
    if (houseAddition) energyLabelUrl.searchParams.set('huisnummertoevoeging', houseAddition)

    const energyLabelConfig = {
      headers: {
        'Content-Type': 'application/json',
        Authorization: process.env.ENERGY_LABEL_API_KEY,
      },
    }

    const requests = [
      axios.get(bagUrl, bagConfig).catch(() => ({})),
      axios.get(energyLabelUrl, energyLabelConfig).catch(() => ({})),
    ]

    let area, buildYear, energyLabelTemp, energyLabel, city, addressId, streetNameFromApi, houseNumberFromApi, houseLetterFromApi, houseAdditionFromApi, postcodeFromApi, woz, monument, wozValue, isMonument, energyIndex


    await Promise.all(requests)
      .then(async (responses) => {
        const data = responses.map((response) => response.data)

        if (!data[0]?._embedded?.adressen?.[0]) {
          throw new Error('Address not found')
        }

        area = data[0]._embedded.adressen[0]._embedded.adresseerbaarObject.verblijfsobject.verblijfsobject.oppervlakte
        buildYear = data[0]._embedded.adressen[0]._embedded.panden[0].pand.oorspronkelijkBouwjaar

        energyLabelTemp = data[1]
        energyLabel = energyLabelTemp ? energyLabelTemp[0]?.Energieklasse : 'Not found'

        city = data[0]._embedded.adressen[0].woonplaatsNaam
        addressId = data[0]._embedded.adressen[0].adresseerbaarObjectIdentificatie

        streetNameFromApi = data[0]._embedded.adressen[0]?.openbareRuimteNaam
        houseNumberFromApi = data[0]._embedded.adressen[0]?.huisnummer
        houseLetterFromApi = data[0]._embedded.adressen[0]?.huisletter
        houseAdditionFromApi = data[0]._embedded.adressen[0]?.huisnummertoevoeging
        postcodeFromApi = data[0]._embedded.adressen[0]?.postcode

        return await scrapeLogic(addressString, addressId, streetNameFromApi, houseNumberFromApi, houseLetterFromApi, houseAdditionFromApi, postcodeFromApi)
      })
      .then((result) => {
        wozValue = result.woz
        monument = result.monument
        isMonument = monument
        energyIndex = result.energyIndex


        return calculateRentPrice(
          area,
          buildYear,
          energyLabel,
          wozValue,
          numberOfRooms,
          outdoorSpaceValue,
          kitchen,
          bathroom,
          city,
          isMonument,
          energyIndex,
          periodSignedContract
        )
      })
      .then((result) => {
        res.json({
          area,
          buildYear,
          energyLabel,
          energyIndex,
          wozValue,
          city,
          isMonument,
          result,
          streetNameFromApi,
          houseNumberFromApi,
          houseLetterFromApi,
          houseAdditionFromApi,
          postcodeFromApi,
        })
      })
      .catch((error) => {
        console.error("Error in processing request:", error)

        let errMessage =
              'Error. Check if your address is typed in correctly. Try setting addition as house letter, or vice versa. If you still get the same error, try using our <a href="https://docs.google.com/spreadsheets/d/1F4OwREupVtWmzfWkL0Xk77ZkTwVRz1WCL6C-aAUHov0/edit?gid=1374918462#gid=1374918462" target="_blank">Calculator Spreadsheet</a>.'
        res.json({ errMessage })
      })
  } finally {
    processing = false // Release the lock after processing
    processQueue() // Process the next request in the queue
  }
}

app.post('/api/search', (req, res) => {
  requestQueue.push({ req, res }) // Add request to queue
  processQueue() // Start processing queue if not already processing

  trackFunctionCalls()
})

function pingServer() {
  const serverUrl = 'https://rentcalculator.onrender.com'

  axios.get(serverUrl).catch((error) => {
    console.error('Error pinging server:', error)
  })
}

cron.schedule('*/10 * * * *', pingServer)

const __dirname1 = path.resolve()
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname1, '/dist')))

  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname1, 'dist', 'index.html'))
  })
} else {
  app.get('/', (req, res) => {
    res.send('API is running')
  })
}

const PORT = process.env.PORT || 10000
app.listen(PORT, console.log(`Server started on PORT ${PORT}`))
