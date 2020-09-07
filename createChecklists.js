const meow = require('meow')
const fs = require('fs').promises
const Papa = require('papaparse')
const comments = require('./comments.json')
const cli = meow(`
  Usage
    $ node createChecklists.js input [opts]

  Arguments
    input       The input file

  Options
    --start     The starting time
    --ends      An end time
    --export    Export results to a file

  Examples
    $ node createChecklists.js
`, {
  flags: {
    start: {
      type: 'string'
    },
    end: {
      type: 'string'
    },
    export: {
      type: 'boolean'
    }
  }
})
const _ = require('lodash')
const moment = require('moment')
const chalk = require('chalk')

async function getData (input) {
  input = await fs.readFile(input, 'utf8')
  input = Papa.parse(input, { header: true })
  // Remove newline at end of file
  input.data = input.data.filter(x => x.season !== '')
  return input
}

function getDates (input, opts) {
  const dates = {}
  const unique = _.uniq(_.map(input, (x) => {
    if (opts && opts.start && opts.end) {
      if (moment(x.real_detection_time, 'MM/DD/YY HH:mm:ss').isBetween(opts.start, opts.end)) {
        return x.date
      }
      // Drop any dates which don't match
    } else {
      return x.date
    }
  })).filter(x => x)
  unique.forEach(x => {
    dates[x] = {}
  })
  return dates
}

function makeHourBuckets (input, dates, opts) {
  _.forEach(Object.keys(dates), date => {
    const dateObj = _.find(input.data, ['date', date])
    // Add the initial time
    dates[date][dateObj.recording_start] = []
    // Figure out how many buckets to make
    const duration = dateObj.recording_length.split(':')[0]
    const momentDuration = moment.duration({
      hours: duration,
      minutes: dateObj.recording_length.split(':')[1],
      seconds: dateObj.recording_length.split(':')[2]
    })
    let startingHour = parseInt(dateObj.recording_start.split(':')[0])
    const endingHour = moment(`${dateObj.date} ${dateObj.recording_start}`, 'MM/DD/YY hh:mm:ss').add(momentDuration)
    // Make an array of the times for that night
    const automaticHourArray = []
    let hourString
    for (let i = 1; startingHour + i < 24 && i <= endingHour.hour(); (startingHour + i === 23) ? i = 0 : i++) {
      hourString = `${startingHour + i}:00:00`
      automaticHourArray.push(hourString)
      if (startingHour + i === 23) {
        startingHour = 0
        i = -1
      }
    }
    // Add the times to the date object, for the right day
    automaticHourArray.forEach(hour => {
      let newDate
      if (parseInt(hour.split(':')[0]) >= 12) {
        dates[date][hour] = []
      } else {
        newDate = moment(date, 'MM/DD/YY').add(1, 'day').format('MM/DD/YY')
        if (!dates[newDate]) {
          dates[newDate] = {}
        }
        dates[newDate][hour] = []
      }
    })
  })
  return dates
}

function findDetector (string) {
  return (string === 'tseep') ? 'Tseeps' : 'Thrushes'
}

function getDuration (buckets, date, hour, arr, key, opts) {
  function getRecordingEnd (entry) {
    return moment(`${entry.date} ${entry.recording_start}`, 'MM/DD/YY hh:mm:ss').add(moment.duration({
      hours: entry.recording_length.split(':')[0],
      minutes: entry.recording_length.split(':')[1],
      seconds: entry.recording_length.split(':')[2]
    }))
  }

  function getRecordingStart (entry) {
    return moment(`${entry.date} ${entry.recording_start}`, 'MM/DD/YY hh:mm:ss')
  }

  if (buckets[date][hour] && buckets[date][hour].length === 0) {
    return null
  }

  const end = (opts && opts.end) ? opts.end : getRecordingEnd(buckets[date][hour][0])
  let start = (opts && opts.start) ? opts.start : getRecordingStart(buckets[date][hour][0])

  if (opts && opts.start) {
    if (buckets[date][hour][0] && opts.start.isBefore(getRecordingStart(buckets[date][hour][0]))) {
      start = getRecordingStart(buckets[date][hour][0])
    }
  }
  if (opts && opts.end) {
    if (buckets[date][hour][0] && opts.end.isAfter(getRecordingEnd(buckets[date][hour][0]))) {
      start = getRecordingEnd(buckets[date][hour][0])
    }
  }

  // If the checklist ends within an hour
  if (moment(`${date} ${hour}`, 'MM/DD/YY HH:mm:ss').isSame(end, 'hour')) {
    // Subtract the start time if it is in the same hour
    if (moment(`${date} ${hour}`, 'MM/DD/YY HH:mm:ss').isSame(start, 'hour')) {
      return end.minutes() - start.minutes()
    // Or just use the amount of minutes in the hour
    } else {
      return end.minutes()
    }
  } else if (moment(`${date} ${hour}`, 'MM/DD/YY HH:mm:ss').isSame(start, 'hour')) {
    return 60 - start.minutes()
  }

  return 60
}

function printResults (input, buckets, opts) {
  let counts
  const detector = findDetector(input.data[0].detector)
  Object.keys(buckets).forEach(date => {
    if (Object.keys(buckets[date]).filter(x => buckets[date][x].length !== 0).length) {
      console.log('')
      console.log(chalk.blue(`Date: ${date}`))
      Object.keys(buckets[date]).forEach((hour, key, arr) => {
        if (buckets[date][hour].length !== 0) {
          console.log(`Hour: ${chalk.green(hour.split(':').slice(0, 2).join(':'))}`)
          const duration = getDuration(buckets, date, hour, arr, key, opts)
          if (duration) {
            console.log(`Duration: ${chalk.white(duration)} mins.`)
          }
          counts = _.countBy(buckets[date][hour], 'species')
          Object.keys(counts).forEach(species => {
            if (species === '') {
              console.log(`${detector}:\t`, counts[species])
              // Flag errors often causes by pressing 'N' meaning 'Next'
            } else if (species === 'nowa') {
              console.log(chalk.red(`NOWA:\t ${counts[species]}`))
            } else {
              console.log(`${species.toUpperCase()}:\t`, counts[species])
            }
          })
          console.log('')
        }
      })
    }
  })
}

async function exportResults (input, buckets, opts) {
  const codesFile = Papa.parse(await fs.readFile('codes.csv', 'utf8'), { header: true })
  const codes = {}
  _.forEach(codesFile.data, x => {
    codes[x.Code] = x.Species
  })
  const output = []

  const eBirdReportObj = {
    'Common Name': '', // waterfowl sp.
    Genus: '',
    Species: '',
    Number: '', // 38
    'Species Comments': '', // 1 NFC.
    'Location Name': 'Monsignor Crosby Ave (Yard)', //
    Latitude: '44.258034',
    Longitude: '-72.574655',
    Date: '', // 9/7/2020
    'Start Time': '', // 3:00 AM
    'State/Province': 'VT',
    'Country Code': 'US',
    Protocol: 'stationary', // Needs to be changed manually in eBird.
    'Number of Observers': '1',
    Duration: '', // 60
    'All observations reported?': 'N',
    'Effort Distance Miles': '',
    'Effort area acres': '',
    'Submission Comments': 'Recorded using an OldBird 21c microphone, recording to a NUC7CHYJ using I-Recorded on Windows 10, at 22050Hz, mono, 16bit. Analyzed using Vesper (https://github.com/HaroldMills/Vesper).'
  }

  let counts
  Object.keys(buckets).forEach(date => {
    Object.keys(buckets[date]).forEach((hour, key, arr) => {
      if (hour.length !== 0) {
        counts = _.countBy(buckets[date][hour], 'species')
        Object.keys(counts).forEach(species => {
          const object = {}
          Object.assign(object, eBirdReportObj)
          object.Number = counts[species]
          object.Date = moment(date, 'MM/DD/YY').format('M/DD/YYYY')
          object['Start Time'] = hour.split(':').slice(0, 2).join(':')
          object.Duration = getDuration(buckets, date, hour, arr, key, opts)
          let speciesComment = `${counts[species]} NFC. Detected automatically using Vesper ${input.data[0].detector} detector, available at https://github.com/HaroldMills/Vesper. Manually classified using Vesper by me.`
          // If there is a comment from the comments page, use that
          if (comments[species.toUpperCase()] && !comments[species.toUpperCase()].WIP) {
            speciesComment = `${counts[species]} NFC. ${comments[species.toUpperCase()].text} All NFC calls identified here follow this pattern, unless noted. If the number of identified calls does not match the NFC count, it is because the calls occurred close enough to each other to make it unclear whether or not a single bird was calling. For more on WIWA NFC identification, consult this checklist ${comments[species.toUpperCase()].example}, or the updated page at https://birdinginvermont.com/nfc-species/${species}.`
          }
          object['Species Comments'] = speciesComment
          if (species === '') {
            object['Common Name'] = 'passerine sp.'
          } else if (species === 'nowa') {
            console.log(chalk.red(`NOWA:\t ${counts[species]}`))
          } else {
            object['Common Name'] = codes[species.toUpperCase()]
          }
          output.push(object)
        })
      }
    })
  })

  fs.writeFile('test export.csv', Papa.unparse(output, { header: false }), 'utf8')
}

async function run () {
  const input = await getData(cli.input[0])
  let opts
  if (cli.flags.start && cli.flags.end) {
    opts = {
      start: moment(cli.flags.start, 'YYYY/MM/DD HH:mm:ss'),
      end: moment(cli.flags.end, 'YYYY/MM/DD HH:mm:ss'),
      endingHour: moment(this.end).startOf('hour'),
      finalDuration: moment(this.end).minutes()
    }
  }

  function putEntryInBucket (entry) {
    // Set the hour to match the bucket name
    let hour = `${date.hour()}:00:00`
    // The buckey name includes minutes if it's the starting point
    if (date.hour() === moment(entry.recording_start, 'HH:mm:ss').hour()) {
      hour = moment(entry.recording_start, 'HH:mm:ss').format('HH:mm:ss')
    }
    buckets[date.format('MM/DD/YY')][hour].push(entry)
  }

  const dates = getDates(input.data, opts)

  // Put all of the sightings into eBird hourly buckets
  // TODO Only make buckets you need, sort by opts
  const buckets = makeHourBuckets(input, dates, opts)
  let date
  input.data.forEach(entry => {
    date = moment(entry.real_detection_time, 'MM/DD/YY HH:mm:ss')
    if (opts && opts.start && opts.end) {
      if (date.isBetween(opts.start, opts.end)) {
        putEntryInBucket(entry)
      }
    } else {
      putEntryInBucket(entry)
    }
  })

  printResults(input, buckets, opts)
  if (cli.flags.export) {
    exportResults(input, buckets, opts)
  }
}

run()
