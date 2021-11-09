/**
 * Decoder for Abeeway Microtracker.
 *From Abeeway Tracker Reference Guide FW 2.1 V1.3
 */
function Decoder(bytes, port) {

  // nbits: number of bits used to encode
  // lo: min value that can be encoded
  // hi: max value that can be encoded
  // nresv: number of reserved values, not used for the encoding
  function step_size(lo, hi, nbits, nresv) {
    return 1.0 / ((((1<<nbits) - 1) - nresv) / (hi - lo));
  }

  function mt_value_decode(value, lo, hi, nbits, nresv) {
    return (value - nresv / 2) * step_size(lo, hi, nbits, nresv) + lo;
  }

  // Gets the zero-based unsigned numeric value of the given bit(s)
  function bits(value, lsb, msb) {
    var len = msb - lsb + 1;
    var mask = (1<<len) - 1;
    return value>>lsb & mask;
  }

  // Gets the boolean value of the given bit
  function bit(value, bit) {
    return (value & (1<<bit)) > 0;
  }

  // Gets a hexadecimal representation ensuring a leading zero for each byte
  function hex(bytes, separator) {
    return bytes.map(function (b) {
      return ("0" + b.toString(16)).substr(-2);
    }).join(separator || "");
  }

  // Decodes 4 bytes into a signed integer, MSB
  function int32(bytes) {
    // JavaScript bitwise operators always work with 32 bits signed integers
    return bytes[0]<<24 | bytes[1]<<16 | bytes[2]<<8 | bytes[3];
  }

  // Decodes 4 bytes into an unsigned integer, MSB
  function uint32(bytes) {
   
    return (bytes[0]<<24 | bytes[1]<<16 | bytes[2]<<8 | bytes[3])>>>0;    
  }

  // Decodes 1 to 4 MAC addresses and their RSSI
  function mac_rssi(bytes) {
    var items = [];
    for (var offset = 0; offset < bytes.length; offset += 7) {
      items.push({
        mac_address: hex(bytes.slice(offset, offset + 6), ":"),
        // Sign-extend to 32 bits to support negative values; dBm
        rssi: bytes[offset + 6]<<24>>24,
      });
    }
    return items;
  }

  function message(code, descriptions) {
    return {
      code: code,
      description: code < 0 || code >= descriptions.length ? "UNKNOWN" : descriptions[code]
    };
  }

  var decoded = {};
  var i;

  var type = bytes[0];

  // All message types, except for Frame pending messages, share the same header
  if (type !== 0x00) {
    // Note: the Data Storage Integration stores nested objects as text
    decoded.status = {
      mode: message(bits(bytes[1], 5, 7), ["Standby", "Motion tracking", "Permanent tracking",
        "Motion start/end tracking", "Activity tracking", "OFF"]),
      sos: bit(bytes[1], 4),
      tracking: bit(bytes[1], 3),
      moving: bit(bytes[1], 2),
      periodic: bit(bytes[1], 1),
      on_demand: bit(bytes[1], 0)
    };

    // Trackers with a rechargeable battery:the percentage reflects the actual value
    decoded.batteryPersentage = bytes[2];
    //Temperature
    decoded.temperature = Math.round(100 * mt_value_decode(bytes[3], -44, 85, 8, 0)) / 100;
    
    decoded.ack = bits(bytes[4], 4, 7);
    
    decoded.data = bits(bytes[4], 0, 3);
    //MCU and BLE fwVersion
    decoded.lastResetCause = "lastResetCause: " + bytes[5];
    decoded.mcuFirmware = "fwVersion: " + bytes[6] + "." + bytes[7] + "." + bytes[8];
    decoded.bleFirmware = "bleFwVersion" + bytes[9] + "." + bytes[10] + "." + bytes[11];

  }

  switch (type) {
    case 0x00:
      decoded.type = "FRAME PENDING";
      decoded.token = bytes[1];
      break;

    case 0x03:
      decoded.type = "POSITION";
      switch (decoded.data) {
        case 0:
          decoded.position_type = "GPS fix";
          decoded.age = mt_value_decode(bytes[5], 0, 2040, 8, 0);
          // Signed 32 bits integers; LSB is always zero
          decoded.latitude = (bytes[6]<<24 | bytes[7]<<16 | bytes[8]<<8) / 1e7;
          decoded.longitude = (bytes[9]<<24 | bytes[10]<<16 | bytes[11]<<8) / 1e7;
          // Estimated Horizontal Position Error
          //decoded.ehpe = mt_value_decode(bytes[12], 0, 1000, 8, 0);
          decoded.accuracy = mt_value_decode(bytes[12], 0, 1000, 8, 0);
          //No altitude provided from tracker
          decoded.altitude = 0;
          break;

        case 1:
          decoded.position_type = "GPS timeout";
          decoded.timeout_cause = message(bytes[5], ["User timeout cause"]);
          for (i = 0; i < 4; i++) {
            // Carrier over noise (dBm) for the i-th satellite seen
            decoded["cn" + i] = mt_value_decode(bytes[6 + i], 0, 2040, 8, 0);
          }
          break;

        case 2:
          // Documented as obsolete
          decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data]);
          break;

        case 3:
          decoded.position_type = "WIFI timeout";
          for (i = 0; i < 6; i++) {
            decoded["v_bat" + (i + 1)] = mt_value_decode(bytes[5 + i], 2.8, 4.2, 8, 2);
          }
          break;

        case 4:
          decoded.position_type = "WIFI failure";
          for (i = 0; i < 6; i++) {
            // Most of time a WIFI timeout occurs due to a low battery condition
            decoded["v_bat" + (i + 1)] = mt_value_decode(bytes[5 + i], 2.8, 4.2, 8, 2);
          }
          decoded.error = message(bytes[11], ["WIFI connection failure", "Scan failure",
            "Antenna unavailable", "WIFI not supported on this device"]);
          break;

        case 5:
        case 6:
          decoded.position_type = "LP-GPS data";
          // Encrypted; not described in the documentation
          decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data]);
          break;

        case 7:
          decoded.position_type = "BLE beacon scan";
          decoded.age = mt_value_decode(bytes[5], 0, 2040, 8, 0);
          // Remaining data: up to 4 beacons
          decoded.beacons = mac_rssi(bytes.slice(6));
          break;

        case 8:
          decoded.position_type = "BLE beacon failure";
          decoded.error = message(bytes[5], ["BLE is not responding", "Internal error", "Shared antenna not available",
            "Scan already on going", "No beacon detected", "Hardware incompatibility"]);
          break;

        // Test with: 0358D895090EC46E1FF44B9EB76466B3B87454AD500959CA1ED4AD525E67DA14A1AC
        // or 032CD1890900C46E1FF44B9EC5C83A355A3898A6
        case 9:
          decoded.position_type = "WIFI BSSIDs";
          decoded.age = mt_value_decode(bytes[5], 0, 2040, 8, 0);
          // Remaining data: up to 4 WiFi BSSIDs
          decoded.stations = mac_rssi(bytes.slice(6));
          break;

        default:
          decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data]);
      }
      break;

    case 0x04:
      decoded.type = "ENERGY STATUS";
      break;

    case 0x05:
      decoded.type = "HEARTBEAT";
      break;

    case 0x07:
      // Activity status message and configuration message share the same identifier
      var tag = bytes[5];
      switch (tag) {
        case 1:
          decoded.type = "ACTIVITY STATUS";
          decoded.activity_counter = uint32(bytes.slice(6, 10));
          break;

        case 2:
          decoded.type = "CONFIGURATION";
          for (i = 0; i < 5; i++) {
            var offset = 6 + 5 * i;
            decoded["param" + i] = {
              type: bytes[offset],
              value: uint32(bytes.slice(offset + 1, offset + 5))
            };
          }
          break;

        default:
          decoded.error = message(0, ["UNSUPPORTED POSITION TYPE " + decoded.data + "/" + tag]);
      }
      break;

    case 0x09:
      decoded.type = "SHUTDOWN";
      break;

    case 0xFF:
      decoded.type = "DEBUG";
      break;

    default:
      decoded.error = message(0, ["UNSUPPORTED MESSAGE TYPE " + type]);
  }

  // Just some redundant debug info
  decoded.debug = {
    payload: hex(bytes),
    length: bytes.length,
    port: port,
    server_time: new Date().toISOString()
  };

  return decoded;
}
