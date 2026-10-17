// Offline snapshot of the db.satnogs.org SSTV satellites (transmitters with
// downlink mode = SSTV, mode id 5). Used as a fallback when the SatNOGS DB API
// is unreachable. Regenerated from the API; see server/sstvSats.js.
//
// Each entry: { norad, name, countries, status, active,
//   freqs: [{ down (Hz), desc, status, alive }] }.
export const SSTV_FALLBACK = [
  {
    "norad": 57206,
    "name": "AHMAT-1",
    "countries": "RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437050000,
        "desc": "Mode U - SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 61762,
    "name": "ArcticSat-1",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 435890000,
        "desc": "Mode U - Robot 36 SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 60239,
    "name": "Ariane 6 - Upper Stage",
    "countries": "",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 144550000,
        "desc": "Mode V - GENESIS-A (YPSAT) (Payload) - SSTV (Robot 36)",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 99355,
    "name": "AZAADISAT",
    "countries": "IN",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437400000,
        "desc": "Mode U SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 62461,
    "name": "BGS ARPIT",
    "countries": "IN",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 145870000,
        "desc": "Mode V - SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 98533,
    "name": "CAS-11",
    "countries": "",
    "status": "future",
    "active": true,
    "freqs": [
      {
        "down": 2405500000,
        "desc": "Mode S - SSTV - PD120",
        "status": "active",
        "alive": true
      },
      {
        "down": 2405500000,
        "desc": "Mode S - SSTV - Robot36",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 58613,
    "name": "CLARKSAT-1",
    "countries": "JP",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 435130000,
        "desc": "Modu U - DigitalkerSSTV (FM) - Robot 36",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 48274,
    "name": "CSS (Tianhe)",
    "countries": "CN",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 145985000,
        "desc": "4A V/V imaging SSTV-FM",
        "status": "active",
        "alive": true
      },
      {
        "down": 436510000,
        "desc": "4B U/U imaging SSTV-FM",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 63427,
    "name": "Fram2",
    "countries": "US",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437550000,
        "desc": "Mode U - SSTV Robot36 - Fram2Ham",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 99323,
    "name": "FSI-SAT 1",
    "countries": "JP",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437175000,
        "desc": "Mode U - SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 98326,
    "name": "FSI-SAT2",
    "countries": "JP",
    "status": "in orbit",
    "active": false,
    "freqs": [
      {
        "down": 437175000,
        "desc": "Mode U/U SSTV by DTMF uplink",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 67279,
    "name": "GALAPAGOS-UTE-SWSU",
    "countries": "EC",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437050000,
        "desc": "Mode U - SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 51080,
    "name": "HADES",
    "countries": "ES",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 436888000,
        "desc": "Mode U - SSTV Robot 36",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 53462,
    "name": "HSU-SAT1",
    "countries": "JP",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437280000,
        "desc": "Mode U - SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 62616,
    "name": "INNOCUBE",
    "countries": "DE",
    "status": "in orbit",
    "active": false,
    "freqs": [
      {
        "down": 437020000,
        "desc": "Mode U SSTV (Scottie DX)",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 25544,
    "name": "ISS",
    "countries": "RU,US",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 145480000,
        "desc": "TEMP Off-Frequency SSTV",
        "status": "inactive",
        "alive": false
      },
      {
        "down": 145800000,
        "desc": "Mode V Imaging",
        "status": "active",
        "alive": true
      },
      {
        "down": 437550000,
        "desc": "Mode PD120 FRAM2 Ham ISS simulation",
        "status": "inactive",
        "alive": false
      },
      {
        "down": 437550000,
        "desc": "Mode U - SSTV - Robot-36",
        "status": "active",
        "alive": true
      },
      {
        "down": 437800000,
        "desc": "Mode U - SSTV",
        "status": "active",
        "alive": true
      },
      {
        "down": 437800000,
        "desc": "Mode U - Imaging",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 98248,
    "name": "JAMX01",
    "countries": "CN",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 435175000,
        "desc": "Mode U - SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 98429,
    "name": "Lobachevsky",
    "countries": "RU",
    "status": "in orbit",
    "active": false,
    "freqs": [
      {
        "down": 436320000,
        "desc": "Mode U - SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 57180,
    "name": "Monitor-3",
    "countries": "RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 435290000,
        "desc": "Mode U - Robot 36 SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 61765,
    "name": "MORDOVIA-IOT",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437090000,
        "desc": "SSTV - Robot 36",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 57190,
    "name": "Nanozond-1",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437000000,
        "desc": "Mode U - SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 43937,
    "name": "NEXUS",
    "countries": "JP",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437075000,
        "desc": "SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 47960,
    "name": "Orbicraft-Zorkiy",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437850000,
        "desc": "Mode U SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 44354,
    "name": "PSAT-2",
    "countries": "US",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 435350000,
        "desc": "Mode U SSTV active in sun",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 67291,
    "name": "QMR-KWT 2",
    "countries": "KW,RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 436950000,
        "desc": "SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 65732,
    "name": "RSP-03",
    "countries": "JP",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437050000,
        "desc": "Mode U SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 61785,
    "name": "RTU MIREA1",
    "countries": "RU",
    "status": "in orbit",
    "active": false,
    "freqs": [
      {
        "down": 436200000,
        "desc": "Mode U - SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 61766,
    "name": "RUZAEVKA-390",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437050000,
        "desc": "SSTV - Robot 36",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 67290,
    "name": "SAKHACUBE-CHOLBON",
    "countries": "RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437350000,
        "desc": "SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 32791,
    "name": "SEEDS II",
    "countries": "JP",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437485000,
        "desc": "Mode U SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 44400,
    "name": "SONATE",
    "countries": "DE",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 145840000,
        "desc": "Mode V SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 59112,
    "name": "SONATE-2",
    "countries": "",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 145880000,
        "desc": "Mode V - SSTV - Martin M1 SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 39770,
    "name": "SPROUT",
    "countries": "JP",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437600000,
        "desc": "SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 49396,
    "name": "TeikyoSat-4",
    "countries": "JP",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437450000,
        "desc": "Mode U - SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 1430,
    "name": "TIROS-10",
    "countries": "",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 235000000,
        "desc": "TV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 57172,
    "name": "UmKA-1",
    "countries": "RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437625000,
        "desc": "Mode U - SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 57203,
    "name": "UTMN2",
    "countries": "RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 436125000,
        "desc": "Mode U - Robot 36 SSTV",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 57189,
    "name": "VIZARD-meteo",
    "countries": "RU",
    "status": "in orbit",
    "active": true,
    "freqs": [
      {
        "down": 437825000,
        "desc": "SSTV - Robot 72",
        "status": "active",
        "alive": true
      }
    ]
  },
  {
    "norad": 99377,
    "name": "YuZGU-55 10",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437087000,
        "desc": "Mode U Payload SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 99371,
    "name": "YuZGU-55 11",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437113000,
        "desc": "Mode U Payload SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 99370,
    "name": "YuZGU-55 12",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437000000,
        "desc": "Mode U Payload SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 99372,
    "name": "YuZGU-55 5",
    "countries": "RU",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437050000,
        "desc": "Mode U Payload RS10S SSTV",
        "status": "inactive",
        "alive": false
      }
    ]
  },
  {
    "norad": 61783,
    "name": "ZIMSAT-2",
    "countries": "RU,ZW",
    "status": "re-entered",
    "active": false,
    "freqs": [
      {
        "down": 437050000,
        "desc": "SSTV - Robot 36",
        "status": "inactive",
        "alive": false
      }
    ]
  }
];
