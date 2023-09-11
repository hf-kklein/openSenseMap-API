'use strict';

/**
 * @apiDefine ExposureFilterParam
 * @apiParam {String="indoor","outdoor","mobile","unknown"} [exposure] only include boxes with this exposure. Allows to specify multiple exposures separated by comma (Example: `indoor,mobile`)
 */

/**
 * MQTT broker integration data
 * @apiDefine MqttOption Settings for a senseBox connected through MQTT
 */

/**
 * @apiDefine MqttBody
 *
 * @apiParam (MqttOption) {Boolean} enabled="false" enable or disable mqtt
 * @apiParam (MqttOption) {String} url the url to the mqtt server.
 * @apiParam (MqttOption) {String} topic the topic to subscribe to.
 * @apiParam (MqttOption) {String="json","csv"} messageFormat the format the mqtt messages are in.
 * @apiParam (MqttOption) {String} decodeOptions a json encoded string with options for decoding the message. 'jsonPath' for 'json' messageFormat.
 * @apiParam (MqttOption) {String} connectionOptions a json encoded string with options to supply to the mqtt client (https://github.com/mqttjs/MQTT.js#client)
 */

/**
 * thethingsnetwork.org integration data
 * @apiDefine TTNOption Settings for a senseBox connected through thethingsnetwork.org (TTN)
 */

/**
 * @apiDefine TTNBody
 *
 * @apiParam (TTNOption) {String} dev_id The device ID recieved from TTN
 * @apiParam (TTNOption) {String} app_id The application ID recieved from TTN
 * @apiParam (TTNOption) {String="lora-serialization","sensebox/home","json","debug", "cayenne-lpp"} profile A decoding profile matching the payload format. For details and configuration see https://github.com/sensebox/ttn-osem-integration#decoding-profiles
 * @apiParam (TTNOption) {Array}  [decodeOptions] A JSON Array containing decoder configuration, needed for some profiles.
 * @apiParam (TTNOption) {Number} [port] The TTN port to listen for messages. Optional, if not provided, all ports are used.
 */

const
  { Box, User, Claim } = require('@sensebox/opensensemap-api-models'),
  { addCache, clearCache, checkContentType, redactEmail, postToMattermost } = require('../helpers/apiUtils'),
  { point } = require('@turf/helpers'),
  classifyTransformer = require('../transformers/classifyTransformer'),
  {
    retrieveParameters,
    parseAndValidateTimeParamsForFindAllBoxes,
    validateFromToTimeParams,
    checkPrivilege,
    validateDateNotPast
  } = require('../helpers/userParamHelpers'),
  handleError = require('../helpers/errorHandler'),
  jsonstringify = require('stringify-stream'),
  { v4: uuidv4 } = require('uuid'),
  bcrypt = require('bcrypt'),
  { preparePasswordHash } = require('./usersController'),
  ModelError = require('../../../models/src/modelError');
// New PostgreSQL connector
const db = require('../db');

/**
 * @apiDefine Addons
 * @apiParam {String="feinstaub"} addon specify a sensor addon for a box.
 */

/**
 * @api {put} /boxes/:senseBoxId Update a senseBox
 * @apiDescription
 * Modify the properties of a senseBox. Almost every aspect of a senseBox can be modified through this endpoint.
 *
 * ### Creating, updating or deleting sensors:
 *
 * Your request should contain a `sensors` array with at least one `sensor` object. You'll need to specify at least one of these properties:
 *
 * - `sensor` object has `"edited"` key present: Tell the API to replace all keys of the sensor with the specified `_id` with the supllied keys. (Specify all properties! `{ _id, title, unit, sensorType, icon }`)
 * - `sensor` object has `"edited"` and `"new"` keys: Tell the API this sensor is new and should be added to the senseBox. (Specify all properties! `{ title, unit, sensorType }`)
 * - `sensor` object has `"deleted"` key: Tell the API to delete this sensor from the senseBox. **Also deletes all measurements of this sensor!!** Needs the `_id` property.
 *
 * `sensor` objects without `edited`, `new`, or `deleted` keys will be ignored!
 *
 * @apiUse SensorBody
 * @apiUse LocationBody
 * @apiUse MqttBody
 * @apiUse TTNBody
 *
 * @apiParam (RequestBody) {String} [name] the name of this senseBox.
 * @apiParam (RequestBody) {String[]} [grouptag] the grouptag(s) of this senseBox. Send [] (empty array) to delete this property.
 * @apiParam (RequestBody) {Location} [location] the new coordinates of this senseBox. Measurements will keep the reference to their correct location
 * @apiParam (RequestBody) {Sensor[]} [sensors] an array containing the sensors of this senseBox. Only use if model is unspecified
 * @apiParam (RequestBody) {MqttOption} [mqtt] settings for the MQTT integration of this senseBox
 * @apiParam (RequestBody) {TTNOption} [ttn] settings for the TTN integration of this senseBox
 * @apiParam (RequestBody) {String} [description] the updated description of this senseBox. Send '' (empty string) to delete this property.
 * @apiParam (RequestBody) {String} [image] the updated image of this senseBox encoded as base64 data uri. To delete the current image, send 'deleteImage: true'.
 * @apiParam (RequestBody) {Object} [addons] allows to add addons to the box. Submit as Object with key `add` and the desired addon as value like `{"add":"feinstaub"}`
 * @apiParam (Sensor) {String} edited *Value is ignored. Presence alone is enough* Tell the API to consider this sensor for changing or deleting. Specify all properties, even if not changed!
 * @apiParam (Sensor) {String} new *Value is ignored. Presence alone is enough* Tell the API to add this new sensor to the senseBox.
 * @apiParam (Sensor) {String} deleted *Value is ignored. Presence alone is enough* Tell the API to delete this sensor from the senseBox. *Warning: This will also delete all measurements of this sensor*
 * @apiParamExample {json} Request-Example:
 * {
 *  "_id": "56e741ff933e450c0fe2f705",
 *  "name": "my senseBox",
 *  "description": "this is just a description",
 *  "weblink": "https://opensensemap.org/explore/561ce8acb3de1fe005d3d7bf",
 *  "grouptag": "senseBoxes99",
 *  "exposure": "indoor",
 *  "sensors": [
 *    {
 *      "_id": "56e741ff933e450c0fe2f707",
 *      "title": "UV-Intensität",
 *      "unit": "μW/cm²",
 *      "sensorType": "VEML6070",
 *      "icon": "osem-sprinkles",
 *      "edited": "true"
 *    }
 *  ],
 *  "location": {
 *    "lng": 8.6956,
 *    "lat": 50.0430
 *  },
 *  "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAIVBMVEUAAABKrkMGteh0wW5Ixu931vKy3bO46fj/7hr/+J36/vyFw5EiAAAAAXRSTlMAQObYZgAAAF5JREFUeAFdjdECgzAIA1kIUvP/HzyhdrPe210L2GLYzhjj7VvRefmpn1MKFbdHUOzA9qRQEhIw3xMzEVeJDqkOrC9IJqWE7hFDLZ0Q6+zh7odsoU/j9qeDPXDf/cEX1xsDKIqAkK8AAAAASUVORK5CYII=",
 *  "mqtt": {
 *    "url": "some url",
 *    "topic": "some topic",
 *    "messageFormat": "json",
 *    "decodeOptions": "{\"jsonPath\":\"$.bla\"}"
 *  }
 *  "ttn": {
 *    "app_id": "my-app-id-from-ttn",
 *    "dev_id": "my-dev-id-from-ttn",
 *    "profile": "sensebox/home",
 *    "decodeOptions": "{\"jsonPath\":\"$.bla\"}"
 *  },
 *  "addons": { "add": "feinstaub" }
 * }
 * @apiGroup Boxes
 * @apiName updateBox
 * @apiUse JWTokenAuth
 * @apiUse BoxIdParam
 * @apiUse ContentTypeJSON
 *
 */
const updateBox = async function updateBox (req, res) {
// ---- Postgres DB ----
// FIXME: updatedAt should be self assigned by Postgres Table
// FIXME: grouptag, image, addon and weblink are missing in DEVICE Postgres Schema
// TODO: mqtt and ttn fields are missing; new sketch will not yet be send on sensor change
// TODO: not sure whether several fields should be editable, including: 'exposure', 'model', 'useAuth', 'public', 'status', 'userId'
  const boxId = req._userParams.boxId;
  const newBoxData = req._userParams;

  const updatedDevice = {
    name: req.body.name,
    updatedAt: new Date().toISOString(),
    description: req.body.description,
    exposure: req.body.exposure,
    useAuth: true,
    model: req.body.model,
    public: true,
    status: req.body.status,
    latitude: req.body.location ? req.body.location.lat : undefined,
    longitude: req.body.location ? req.body.location.lng : undefined,
    userId: req.body.user_id
  };
  let setStatement = ''
  for (const key in updatedDevice) {
    if (Object.hasOwnProperty.call(updatedDevice, key)) {
      const element = updatedDevice[key];
      if (element) {
        setStatement += `"${key}" = '${element}',`
      }
    }
  }
  if (setStatement.endsWith(',')) {
    setStatement = setStatement.slice(0, -1); // Remove the last character
  }



  const updateDeviceQuery = `
      UPDATE "Device"
      SET ${setStatement}
      WHERE "id" = $1
      RETURNING *;
    `;
  const values = [boxId];

  try {
    await db.query('BEGIN');

    const result = await db.query(updateDeviceQuery, values);
    await updateSensor(req.body.sensors, boxId)
    await db.query('COMMIT');
    res.send({ code: 'Ok', data: updatedDevice });
    return result.rows[0];
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  // ---- Mongo DB ----
  // try {
  //   let box = await Box.findBoxById(req._userParams.boxId, { lean: false, populate: false });
  //   box = await box.updateBox(req._userParams);
  //   if (box._sensorsChanged === true) {
  //     req.user.mail('newSketch', box);
  //   }

  //   res.send({ code: 'Ok', data: box.toJSON({ includeSecrets: true }) });
  //   clearCache(['getBoxes']);
  // } catch (err) {
  //   return handleError(err);
  // }
};

  // ---- Postgres DB ----
async function updateSensor(sensorData, boxId) {
  for (const { _id, title, unit, sensorType, status, icon, deleted, edited, new: isNew } of sensorData) {
    console.log(_id, title, unit, sensorType, status, icon, deleted, edited, isNew);
    const updatedAt = new Date().toISOString(); // Current ISO timestamp

    const values = [];
    const updateFields = [];
    let query;

    if (deleted) {
      query = `
            DELETE FROM "Sensor"
            WHERE "id" = $1;
          `;
      values.push(_id);
    } else if (edited && isNew) {
      query = `
            INSERT INTO "Sensor" ("id", "title", "unit", "sensorType", "status", "icon", "updatedAt", "deviceId")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
          `;
      values.push(_id, title, unit, sensorType, status, icon, updatedAt, boxId);
    } else if (edited && !deleted) {
      if (title !== undefined) {
        updateFields.push(`"title" = $${values.push(title)}`);
      }
      if (unit !== undefined) {
        updateFields.push(`"unit" = $${values.push(unit)}`);
      }
      if (sensorType !== undefined) {
        updateFields.push(`"sensorType" = $${values.push(sensorType)}`);
      }
      if (status !== undefined) {
        updateFields.push(`"status" = $${values.push(status)}`);
      }
      if (icon !== undefined) {
        updateFields.push(`"icon" = $${values.push(icon)}`);
      }

      query = `
            UPDATE "Sensor"
            SET ${updateFields.join(', ')}, "updatedAt" = $${values.push(updatedAt)}
            WHERE "id" = $${values.push(_id)};
          `;
    } else {
      throw new Error(`Invalid operation for sensor with id ${_id}`);
    }
    await db.query(query, values)
  }
}


/**
 * @api {get} /boxes/:senseBoxId/locations Get locations of a senseBox
 * @apiGroup Boxes
 * @apiName getBoxLocations
 * @apiDescription Get all locations of the specified senseBox ordered by date as an array of GeoJSON Points.
 * If `format=geojson`, a GeoJSON linestring will be returned, with `properties.timestamps`
 * being an array with the timestamp for each coordinate.
 *
 * @apiParam {String=json,geojson} format=json
 * @apiParam {RFC3339Date} [from-date] Beginning date of location timestamps (default: 48 hours ago from now)
 * @apiParam {RFC3339Date} [to-date] End date of location timstamps (default: now)
 * @apiUse BoxIdParam
 *
 * @apiSuccessExample {application/json} Example response for :format=json
 * [
 *   { "coordinates": [7.68123, 51.9123], "type": "Point", "timestamp": "2017-07-27T12:00:00Z"},
 *   { "coordinates": [7.68223, 51.9433, 66.6], "type": "Point", "timestamp": "2017-07-27T12:01:00Z"},
 *   { "coordinates": [7.68323, 51.9423], "type": "Point", "timestamp": "2017-07-27T12:02:00Z"}
 * ]
 */
const getBoxLocations = async function getBoxLocations (req, res) {
// ---- Postgres DB ----
// FIXME: there is only a single location for each device, defined via latitude and longitude fields in the DEVICE Postgres Schema
  const { boxId, format, fromDate, toDate } = req._userParams;

  const query = `
    SELECT
      ARRAY[d.longitude, d.latitude] AS coordinates,
      'Point' AS type,
      d."updatedAt" as timestamp
    FROM
      "Device" d
    WHERE
      d.id = $1 
      AND d."updatedAt" >= $2 
      AND d."updatedAt" <= $3;
  `;

  let values = [boxId, fromDate, toDate];

  try {
    let result = await db.query(query, values);
    
    // if result is empty, no Box was found, return Error
    if (result.rowCount === 0) {
      throw new ModelError('Box not found', { type: 'NotFoundError' });
    }

    if (format === 'geojson') {
      const geo = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] },
        properties: { timestamps: [] }
      };

      for (const l of result.rows) {
        geo.geometry.coordinates.push(l.coordinates);
        geo.properties.timestamps.push(l.timestamp);
      }

      result.rows = geo;
    }

    res.send(result.rows);
    return result.rows;
  } catch (err) {
    console.log("An error.")
    return handleError(err);
  };

  // ---- Mongo DB ---- 
  // try {
  //   const box = await Box.findBoxById(req._userParams.boxId, { onlyLocations: true, lean: false });
  //   res.send(await box.getLocations(req._userParams));
  // } catch (err) {
  //   return handleError(err);
  // }
};

const geoJsonStringifyReplacer = function geoJsonStringifyReplacer (key, box) {
  if (key === '') {
    const coordinates = box.currentLocation.coordinates;
    box.currentLocation = undefined;
    box.loc = undefined;

    return point(coordinates, box);
  }

  return box;
};

/**
 * @api {get} /boxes?date=:date&phenomenon=:phenomenon&format=:format Get all senseBoxes
 * @apiDescription With the optional `date` and `phenomenon` parameters you can find senseBoxes that have submitted data around that time, +/- 4 hours, or specify two dates separated by a comma.
 * @apiName getBoxes
 * @apiGroup Boxes
 * @apiParam {String} [name] Search string to find boxes by name, if specified all other parameters are ignored.
 * @apiParam {Number} [limit=5] Limit the search results.
 * @apiParam {RFC3339Date} [date] One or two RFC 3339 timestamps at which boxes should provide measurements. Use in combination with `phenomenon`.
 * @apiParam {String} [phenomenon] A sensor phenomenon (determined by sensor name) such as temperature, humidity or UV intensity. Use in combination with `date`.
 * @apiParam {String=json,geojson} [format=json] the format the sensor data is returned in.
 * @apiParam {String} [grouptag] only return boxes with this grouptag, allows to specify multiple separated with a comma
 * @apiParam {String="homeEthernet","homeWifi","homeEthernetFeinstaub","homeWifiFeinstaub","luftdaten_sds011","luftdaten_sds011_dht11","luftdaten_sds011_dht22","luftdaten_sds011_bmp180","luftdaten_sds011_bme280"} [model] only return boxes with this model, allows to specify multiple separated with a comma
 * @apiParam {Boolean="true","false"} [classify=false] if specified, the api will classify the boxes accordingly to their last measurements.
 * @apiParam {Boolean="true","false"} [minimal=false] if specified, the api will only return a minimal set of box metadata consisting of [_id, updatedAt, currentLocation, exposure, name] for a fast response.
 * @apiParam {Boolean="true","false"} [full=false] if true the API will return populated lastMeasurements (use this with caution for now, expensive on the database)
 * @apiParam {Number} [near] A comma separated coordinate, if specified, the api will only return senseBoxes within maxDistance (in m) of this location
 * @apiParam {Number} [maxDistance=1000] the amount of meters around the near Parameter that the api will search for senseBoxes
 * @apiUse ExposureFilterParam
 * @apiUse BBoxParam
 * @apiSampleRequest https://api.opensensemap.org/boxes
 * @apiSampleRequest https://api.opensensemap.org/boxes?date=2015-03-07T02:50Z&phenomenon=Temperatur
 * @apiSampleRequest https://api.opensensemap.org/boxes?date=2015-03-07T02:50Z,2015-04-07T02:50Z&phenomenon=Temperatur
 */
const getBoxes = async function getBoxes (req, res) {
  // content-type is always application/json for this route
  res.header('Content-Type', 'application/json; charset=utf-8');
  // ---- Postgres DB ----
  // FIXME: DB Field grouptag is missing for Device, thus it can not be used to filter boxes yet
  // TODO: format, near, maxDistance, date and bbox fields are not yet used
  try {
    const params = req._userParams;
    let selectionString = ''

    if (params.minimal === 'true') {
      selectionString += `d.id, d."updatedAt", d.latitude, d.longitude, d.exposure, d.name`
    } else {
      selectionString += 'd.*'
    }

    if(params.classify === 'true') {
      selectionString += `, 
      CASE
        WHEN MAX(m.time) > NOW() - INTERVAL '7 days' THEN 'active'
        WHEN MAX(m.time) > NOW() - INTERVAL '30 days' THEN 'inactive'
        ELSE 'old'
      END AS state
        `
    }
    
    if (params.full === 'true') {
      selectionString += `, 
        json_agg(
        json_build_object(
          'title', s.title,
          'unit', s.unit,
          'sensorType', s."sensorType",
          '_id', s.id,
          'lastMeasurement', (
            SELECT json_build_object(
              'value', m.value,
              'createdAt', m.time
            )
            FROM "Measurement" m
            WHERE m."sensorId" = s.id
            ORDER BY m.time DESC
            LIMIT 1
          )
          )
      ) as sensors`
    }

    const query = `
    SELECT ${selectionString}
    FROM
        "Device" d
    JOIN
        "Sensor" s ON s."deviceId" = d.id
    JOIN "Measurement" m ON m."sensorId" = s.id
    WHERE
    ($1::text IS NULL OR d.name = $1)
    AND ($2::text[] IS NULL OR d.model = ANY($2::text[]))
    AND ($3::"Exposure"[] IS NULL OR d.exposure = ANY($3::"Exposure"[]))
    AND ($4::text IS NULL OR s.title = $4)
    GROUP BY d.id
    LIMIT $5
  `
    const values = [params.name, params.model, params.exposure, params.phenomenon, params.limit]
    const { rows } = await db.query(query, values);
    res.send(rows);
  } catch (err) {
    console.log(err);
    return handleError(err);
  }
  // ---- Mongo DB ---- 
  // // default format
  // let stringifier = jsonstringify({ open: '[', close: ']' });
  // // format
  // if (req._userParams.format === 'geojson') {
  //   stringifier = jsonstringify({ open: '{"type":"FeatureCollection","features":[', close: ']}' }, geoJsonStringifyReplacer);
  // }

  // try {
  //   let stream;

  //   // Search boxes by name
  //   // Directly return results and do nothing else
  //   if (req._userParams.name) {
  //     stream = await Box.findBoxes(req._userParams);
  //   } else {
  //     if (req._userParams.minimal === 'true') {
  //       stream = await Box.findBoxesMinimal(req._userParams);
  //     } else {
  //       stream = await Box.findBoxesLastMeasurements(req._userParams);
  //     }

  //     if (req._userParams.classify === 'true') {
  //       stream = stream
  //         .pipe(new classifyTransformer())
  //         .on('error', function (err) {
  //           res.end(`Error: ${err.message}`);
  //         });
  //     }
  //   }

  //   stream
  //     .pipe(stringifier)
  //     .on('error', function (err) {
  //       res.end(`Error: ${err.message}`);
  //     })
  //     .pipe(res);
  // } catch (err) {
  //   return handleError(err);
  // }
};

/**
 * @api {get} /boxes/:senseBoxId?format=:format Get one senseBox
 * @apiName getBox
 * @apiGroup Boxes
 *
 * @apiUse BoxIdParam
 * @apiParam {String=json,geojson} [format=json] The format the sensor data is returned in. If `geojson`, a GeoJSON Point Feature is returned.
 *
 * @apiSuccessExample Example data on success:
 * {
  "_id": "57000b8745fd40c8196ad04c",
  "createdAt": "2016-06-02T11:22:51.817Z",
  "exposure": "outdoor",
  "grouptag": "",
  "image": "57000b8745fd40c8196ad04c.png?1466435154159",
  "currentLocation": {
    "coordinates": [
      7.64568,
      51.962372
    ],
    "timestamp": "2016-06-02T11:22:51.817Z",
    "type": "Point"
  },
  "name": "Oststr/Mauritzsteinpfad",
  "sensors": [
    {
      "_id": "57000b8745fd40c8196ad04e",
      "lastMeasurement": {
        "value": "0",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "VEML6070",
      "title": "UV-Intensität",
      "unit": "μW/cm²"
    },
    {
      "_id": "57000b8745fd40c8196ad04f",
      "lastMeasurement": {
        "value": "0",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "TSL45315",
      "title": "Beleuchtungsstärke",
      "unit": "lx"
    },
    {
      "_id": "57000b8745fd40c8196ad050",
      "lastMeasurement": {
        "value": "1019.21",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "BMP280",
      "title": "Luftdruck",
      "unit": "hPa"
    },
    {
      "_id": "57000b8745fd40c8196ad051",
      "lastMeasurement": {
        "value": "99.38",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "HDC1008",
      "title": "rel. Luftfeuchte",
      "unit": "%"
    },
    {
      "_id": "57000b8745fd40c8196ad052",
      "lastMeasurement": {
        "value": "0.21",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "sensorType": "HDC1008",
      "title": "Temperatur",
      "unit": "°C"
    },
    {
      "_id": "576996be6c521810002479dd",
      "sensorType": "WiFi",
      "unit": "dBm",
      "title": "Wifi-Stärke",
      "lastMeasurement": {
        "value": "-66",
        "createdAt": "2016-11-11T21:22:01.675Z"
      }
    },
    {
      "_id": "579f9eae68b4a2120069edc8",
      "sensorType": "VCC",
      "unit": "V",
      "title": "Eingangsspannung",
      "lastMeasurement": {
        "value": "2.73",
        "createdAt": "2016-11-11T21:22:01.675Z"
      },
      "icon": "osem-shock"
    }
  ],
  "updatedAt": "2016-11-11T21:22:01.686Z"
}
 */

const getBox = async function getBox (req, res) {
// ---- Postgres DB ----
// FIXME: DB Field grouptag & image are missing for Device, thus not returned here
// TODO: fields without a value are returned with value null, Mongo response omitted missing fields
  const { format, boxId } = req._userParams;
  try {
    const { rows } = await db.query(`
    SELECT 
    d.id as "_id",
    d."createdAt",
    d.exposure,
    json_build_object(
      'coordinates', ARRAY[d.longitude, d.latitude],
      'timestamp', d."updatedAt",
      'type', 'Point'
    ) as "currentLocation",
    d.name,
    json_agg(
      json_build_object(
          '_id', s.id,
          'sensorType', s."sensorType",
          'unit', s.unit,
          'title', s.title,
          'lastMeasurement', (
            SELECT json_build_object(
              'value', m.value,
              'createdAt', m.time
            )
            FROM "Measurement" m
            WHERE m."sensorId" = s.id
            ORDER BY m.time DESC
            LIMIT 1
          ),
          'icon', s.icon
        )
    ) as sensors
    FROM "Device" d
    JOIN
      "Sensor" s ON s."deviceId" = d.id
    WHERE d.id = '${boxId}'
    GROUP BY d.id;
    `);

    if (format === 'geojson') {
      const box = rows[0]
      const coordinates = box.currentLocation.coordinates;
      return res.send(point(coordinates, box));
    }

    res.send(rows);
  } catch (err) {
    return handleError(err);
  }

  // ---- Mongo DB ---- 
  // const { format, boxId } = req._userParams;
  // try {
  //   const box = await Box.findBoxById(boxId);

  //   if (format === 'geojson') {
  //     const coordinates = box.currentLocation.coordinates;
  //     box.currentLocation = undefined;
  //     box.loc = undefined;

  //     return res.send(point(coordinates, box));
  //   }
  //   res.send(box);
  // } catch (err) {
  //   return handleError(err);
  // }

};

/**
 * @api {post} /boxes Post new senseBox
 * @apiGroup Boxes
 * @apiName postNewBox
 * @apiDescription Create a new senseBox. This method allows you to submit a new senseBox.
 *
 * ### MQTT Message formats
 * If you specify `mqtt` parameters, the openSenseMap API will try to connect to the MQTT broker
 * specified by you. The parameter `messageFormat` tells the API in which format you are sending
 * measurements in. The accepted formats are listed under `Measurements/Post mutliple new Measurements`
 *
 * @apiParam (RequestBody) {String} name the name of this senseBox.
 * @apiParam (RequestBody) {String} [grouptag] the grouptag of this senseBox.
 * @apiParam (RequestBody) {String="indoor","outdoor","mobile","unknown"} exposure the exposure of this senseBox.
 * @apiParam (RequestBody) {Location} location the coordinates of this senseBox.
 * @apiParam (RequestBody) {String="homeV2Lora","homeV2Ethernet","homeV2Wifi","homeEthernet","homeWifi","homeEthernetFeinstaub","homeWifiFeinstaub","luftdaten_sds011","luftdaten_sds011_dht11","luftdaten_sds011_dht22","luftdaten_sds011_bmp180","luftdaten_sds011_bme280","hackair_home_v2"} [model] specify the model if you want to use a predefined senseBox model, autocreating sensor definitions.
 * @apiParam (RequestBody) {Sensor[]} [sensors] an array containing the sensors of this senseBox. Only use if `model` is unspecified.
 * @apiParam (RequestBody) {String[]="hdc1080","bmp280","tsl45315","veml6070","sds011","bme680","smt50","soundlevelmeter","windspeed","scd30","dps310","sps30"} [sensorTemplates] Specify which sensors should be included.
 * @apiParam (RequestBody) {Object} [mqtt] specify parameters of the MQTT integration for external measurement upload. Please see below for the accepted parameters
 * @apiParam (RequestBody) {Object} [ttn] specify parameters for the TTN integration for measurement from TheThingsNetwork.org upload. Please see below for the accepted parameters
 * @apiParam (RequestBody) {Boolean="true","false"} [useAuth] whether to use access_token or not for authentication
 * @apiParam (RequestBody) {Boolean="true","false"} [sharedBox] whether to share this box (allows transfer to another user while still being able to read the secret and commit measurements)
 *
 * @apiUse LocationBody
 * @apiUse SensorBody
 * @apiUse MqttBody
 * @apiUse TTNBody
 * @apiUse ContentTypeJSON
 * @apiUse JWTokenAuth
 */
const postNewBox = async function postNewBox (req, res) {
// ---- Postgres DB ----
// FIXME: integrations (mqtt and ttn) are missing in Postgres DB Schema; omitted here
// TODO: integrate sensorTemplates and inference of corresponding sensors based on a given model
  try {
    await db.query('BEGIN');

    const newDevice = {
      // remove id & updatedAt in production, should be self assigned
      id: uuidv4(),
      updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      name: req.body.name,
      description: req.body.description || null,
      exposure: req.body.exposure,
      useAuth: req.body.useAuth || false,
      model: req.body.model || null,
      public: req.body.public || false,
      status: req.body.status || 'INACTIVE',
      latitude: req.body.location.lat,
      longitude: req.body.location.lng,
      userId: req.user.id,
      sensors: req.body.sensors
    };
    
    // Build dynamic SQL query
    let query = `
      INSERT INTO "Device" (id, name, exposure, "useAuth", public, status, latitude, longitude, "userId", "updatedAt"`;
    
    // Define placeholders and values for optional fields
    const placeholders = [];
    const values = [
      newDevice.id,
      newDevice.name,
      newDevice.exposure,
      newDevice.useAuth,
      newDevice.public,
      newDevice.status,
      newDevice.latitude,
      newDevice.longitude,
      newDevice.userId,
      newDevice.updatedAt,
    ];
    let valueString = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10'
    
    if (newDevice.description !== null) {
      placeholders.push(', description');
      valueString += `, $${values.push(newDevice.description)}`;
    }
    
    if (newDevice.model !== null) {
      placeholders.push(', model');
      valueString += `, $${values.push(newDevice.model)}`;
    }
      
    query += placeholders.join('');
    query += `
      )
      VALUES (
        ${valueString}
      )
      RETURNING id;
    `;

    console.log(query);

    const newBox = await db.query(query, values);
    console.log('New device inserted with ID:', newBox.rows[0].id);

    for (const sensorData of newDevice.sensors) {
      const insertSensorQuery = `
        INSERT INTO "Sensor" ("id", "title", "unit", "sensorType", "deviceId", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6);
      `;

      const insertSensorValues = [
        sensorData.id,
        sensorData.title,
        sensorData.unit,
        sensorData.sensorType,
        newBox.rows[0].id, // Use the ID of the inserted box
        new Date().toISOString().slice(0, 19).replace('T', ' '),
      ];

      await db.query(insertSensorQuery, insertSensorValues);
      console.log('New sensor with ID:', sensorData.id, " added to box.");
    }
    await db.query('COMMIT');
    res.send(201, { message: 'Box successfully created', data: newBox.rows[0].id });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error inserting new device:', error);
    throw error;
  }

  // ---- Mongo DB ---- 
  // try {
  //   let newBox = await req.user.addBox(req._userParams);
  //   newBox = await Box.populate(newBox, Box.BOX_SUB_PROPS_FOR_POPULATION);
  //   res.send(201, { message: 'Box successfully created', data: newBox });
  //   clearCache(['getBoxes', 'getStats']);
  //   postToMattermost(
  //     `New Box: ${req.user.name} (${redactEmail(
  //       req.user.email
  //     )}) just registered "${newBox.name}" (${
  //       newBox.model
  //     }): [https://opensensemap.org/explore/${
  //       newBox._id
  //     }](https://opensensemap.org/explore/${newBox._id})`
  //   );
  // } catch (err) {
  //   return handleError(err);
};

/**
 * @api {get} /boxes/:senseBoxId/script Download the Arduino script for your senseBox
 * @apiName getSketch
 * @apiGroup Boxes
 * @apiParam {String="Serial1","Serial2"} [serialPort] the serial port the SDS011 sensor is connected to
 * @apiParam {String="A","B","C"} [soilDigitalPort] the digital port the SMT50 sensor is connected to
 * @apiParam {String="A","B","C"} [soundMeterPort] the digital port the soundlevelmeter sensor is connected to
 * @apiParam {String="A","B","C"} [windSpeedPort] the digital port the windspeed sensor is connected to
 * @apiParam {String} [ssid] the ssid of your wifi network
 * @apiParam {String} [password] the password of your wifi network
 * @apiParam {String} [devEUI] the devEUI of TTN device
 * @apiParam {String} [appEUI] the appEUI of TTN application
 * @apiParam {String} [appKey] the appKey of TTN application
 * @apiParam {Boolean="true","false"} [display_enabled] include code for an attached oled display
 * @apiUse JWTokenAuth
 * @apiUse BoxIdParam
 */
const getSketch = async function getSketch (req, res) {
  res.header('Content-Type', 'text/plain; charset=utf-8');
  try {
    const box = await Box.findBoxById(req._userParams.boxId, { populate: false, lean: false });

    const params = {
      serialPort: req._userParams.serialPort,
      soilDigitalPort: req._userParams.soilDigitalPort,
      soundMeterPort: req._userParams.soundMeterPort,
      windSpeedPort: req._userParams.windSpeedPort,
      ssid: req._userParams.ssid,
      password: req._userParams.password,
      devEUI: req._userParams.devEUI,
      appEUI: req._userParams.appEUI,
      appKey: req._userParams.appKey,
      display_enabled: req._userParams.display_enabled
    };

    // pass access token only if useAuth is true and access_token is available
    if (box.access_token) {
      params.access_token = box.access_token;
    }

    res.send(box.getSketch(params));
  } catch (err) {
    return handleError(err);
  }

  // ---- Postgres DB Work In Progress ----
  // const { rows } = await db.query(`SELECT * FROM "Device" WHERE id = '${boxId}';`);
  // const box = rows[0]
  // const params = {
  //   serialPort: req._userParams.serialPort,
  //   soilDigitalPort: req._userParams.soilDigitalPort,
  //   soundMeterPort: req._userParams.soundMeterPort,
  //   windSpeedPort: req._userParams.windSpeedPort,
  //   ssid: req._userParams.ssid,
  //   password: req._userParams.password,
  //   devEUI: req._userParams.devEUI,
  //   appEUI: req._userParams.appEUI,
  //   appKey: req._userParams.appKey,
  //   display_enabled: req._userParams.display_enabled
  // };

  // // pass access token only if useAuth is true and access_token is available
  // if (box.access_token) {
  //   params.access_token = box.access_token;
  // }

  // res.send(box.getSketch(params));

};

/**
 * @api {delete} /boxes/:senseBoxId Mark a senseBox and its measurements for deletion
 * @apiDescription This will delete all the measurements of the senseBox. Please note that the deletion isn't happening immediately.
 * @apiName deleteBox
 * @apiGroup Boxes
 * @apiUse ContentTypeJSON
 * @apiParam {String} password the current password for this user.
 * @apiUse JWTokenAuth
 * @apiUse BoxIdParam
 */
const deleteBox = async function deleteBox(req, res) {
// ---- Postgres DB ---- 
// FIXME: make sure every measurement is deleted, should be automatically done by cascading? currently not the case. either implement or add deletion logic here.
  const { password, boxId } = req._userParams;
  try {
    await db.query('BEGIN');

    const user = req.user
    
    // Find user's hashed password
    const passwordQuery = 'SELECT * FROM "Password" WHERE "userId" = $1';
    const passwordResult = await db.query(passwordQuery, [user.id]);
    const hashedPassword = passwordResult.rows[0];

    if (!hashedPassword) {
      throw new Error('Invalid password');
    }

    // Compare passwords using bcrypt
    const isPasswordValid = await bcrypt.compare(preparePasswordHash(password), hashedPassword.hash);

    if (!isPasswordValid) {
      throw new Error('Password incorrect', { type: 'ForbiddenError' });
    }

    const deleteBoxQuery = 'DELETE FROM "Device" WHERE id = $1 RETURNING name';
    const { rows } = await db.query(deleteBoxQuery, [boxId]);
    await db.query('COMMIT');
    // Send a response and perform other actions
    res.send({ code: 'Ok', message: 'box and all associated measurements marked for deletion' });
    clearCache(['getBoxes', 'getStats']);
    postToMattermost(`Box deleted: ${user.name} (${redactEmail(user.email)}) just deleted "${rows[0].name}" ${boxId}`);

  } catch (err) {
    await db.query('ROLLBACK');
    console.error(err);
    return handleError(err);
  }

  // ---- Mongo DB ----
  // const { password, boxId } = req._userParams;

  // try {
  //   await req.user.checkPassword(password);
  //   const box = await req.user.removeBox(boxId);
  //   res.send({ code: 'Ok', message: 'box and all associated measurements marked for deletion' });
  //   clearCache(['getBoxes', 'getStats']);
  //   postToMattermost(`Box deleted: ${req.user.name} (${redactEmail(req.user.email)}) just deleted "${box.name}" (${boxId})`);

  // } catch (err) {
  //   return handleError(err);
  // }
};

/**
 * @api {get} /boxes/transfer/:senseBoxId Get transfer information for a senseBox
 * @apiDescription Get transfer information for a senseBox
 * @apiName getTransfer
 * @apiGroup Boxes
 * @apiUse JWTokenAuth
 * @apiUse BoxIdParam
 */
const getTransfer = async function getTransfer (req, res) {
  const { boxId } = req._userParams;
  try {
    const transfer = await Claim.findClaimByDeviceID(boxId);
    res.send(200, {
      data: transfer,
    });
  } catch (err) {
    return handleError(err);
  }
};

/**
 * @api {post} /boxes/transfer Mark a senseBox for transferring to a different user
 * @apiDescription This will mark a senseBox for transfering it to a different user account
 * @apiName createTransfer
 * @apiGroup Boxes
 * @apiParam (RequestBody) {String} boxId ID of the senseBox you want to transfer.
 * @apiParam (RequestBody) {RFC3339Date} expiresAt Expiration date for transfer token (default: 24 hours from now).
 * @apiUse JWTokenAuth
 */
const createTransfer = async function createTransfer (req, res) {
  const { boxId, date } = req._userParams;
  try {
    const transferCode = await req.user.transferBox(boxId, date);
    res.send(201, {
      message: 'Box successfully prepared for transfer',
      data: transferCode,
    });
  } catch (err) {
    return handleError(err);
  }
};

/**
 * @api {put} /boxes/transfer/:senseBoxId Update a transfer token
 * @apiDescription Update the expiration date of a transfer token
 * @apiName updateTransfer
 * @apiGroup Boxes
 * @apiParam (RequestBody) {String} Transfer token you want to update.
 * @apiParam (RequestBody) {RFC3339Date} expiresAt Expiration date for transfer token (default: 24 hours from now).
 * @apiUse JWTokenAuth
 * @apiUse BoxIdParam
 */
const updateTransfer = async function updateTransfer (req, res) {
  const { boxId, token, date } = req._userParams;
  try {
    const transfer = await req.user.updateTransfer(boxId, token, date);
    res.send(200, {
      message: 'Transfer successfully updated',
      data: transfer,
    });
  } catch (err) {
    return handleError(err);
  }
};

/**
 * @api {delete} /boxes/transfer Revoke transfer token and remove senseBox from transfer
 * @apiDescription This will revoke the transfer token and remove the senseBox from transfer
 * @apiName removeTransfer
 * @apiGroup Boxes
 * @apiParam (RequestBody) {String} boxId ID of the senseBox you want to remove from transfer.
 * @apiParam (RequestBody) {String} token Transfer token you want to revoke.
 * @apiUse JWTokenAuth
 */
const removeTransfer = async function removeTransfer (req, res) {
  const { boxId, token } = req._userParams;
  try {
    await req.user.removeTransfer(boxId, token);
    res.send(204);
  } catch (err) {
    return handleError(err);
  }
};

/**
 * @api {post} /boxes/claim Claim a senseBox marked for transfer
 * @apiDescription This will claim a senseBox marked for transfer
 * @apiName claimBox
 * @apiGroup Boxes
 * @apiUse ContentTypeJSON
 * @apiParam (RequestBody) {String} token the token to claim a senseBox
 * @apiUse JWTokenAuth
 */
const claimBox = async function claimBox (req, res) {
  const { token } = req._userParams;

  try {
    const { owner, claim } = await req.user.claimBox(token);
    await User.transferOwnershipOfBox(owner, claim.boxId);

    await claim.expireToken();

    res.send(200, { message: 'Device successfully claimed!' });
  } catch (err) {
    return handleError(err);
  }
};

module.exports = {
  // auth required
  deleteBox: [
    checkContentType,
    retrieveParameters([
      { predef: 'boxId', required: true },
      { predef: 'password' },
    ]),
    checkPrivilege,
    deleteBox,
  ],
  getTransfer: [
    retrieveParameters([{ predef: 'boxId', required: true }]),
    checkPrivilege,
    getTransfer,
  ],
  createTransfer: [
    retrieveParameters([
      { predef: 'boxId', required: true },
      { predef: 'dateNoDefault' },
    ]),
    validateDateNotPast,
    checkPrivilege,
    createTransfer,
  ],
  updateTransfer: [
    retrieveParameters([
      { predef: 'boxId', required: true },
      { name: 'token', dataType: 'String' },
      { predef: 'dateNoDefault', required: true },
    ]),
    validateDateNotPast,
    checkPrivilege,
    updateTransfer,
  ],
  removeTransfer: [
    retrieveParameters([
      { predef: 'boxId', required: true },
      { name: 'token', dataType: 'String' },
    ]),
    checkPrivilege,
    removeTransfer,
  ],
  claimBox: [
    checkContentType,
    retrieveParameters([{ name: 'token', dataType: 'String' }]),
    claimBox,
  ],
  getSketch: [
    retrieveParameters([
      { predef: 'boxId', required: true },
      {
        name: 'serialPort',
        dataType: 'String',
        allowedValues: ['Serial1', 'Serial2'],
      },
      {
        name: 'soilDigitalPort',
        dataType: 'String',
        allowedValues: ['A', 'B', 'C'],
      },
      {
        name: 'soundMeterPort',
        dataType: 'String',
        allowedValues: ['A', 'B', 'C'],
      },
      {
        name: 'windSpeedPort',
        dataType: 'String',
        allowedValues: ['A', 'B', 'C'],
      },
      { name: 'ssid', dataType: 'StringWithEmpty' },
      { name: 'password', dataType: 'StringWithEmpty' },
      { name: 'devEUI', dataType: 'StringWithEmpty' },
      { name: 'appEUI', dataType: 'StringWithEmpty' },
      { name: 'appKey', dataType: 'StringWithEmpty' },
      { name: 'display_enabled', allowedValues: ['true', 'false'] },
    ]),
    checkPrivilege,
    getSketch,
  ],
  updateBox: [
    checkContentType,
    retrieveParameters([
      { predef: 'boxId', required: true },
      { name: 'name' },
      { name: 'grouptag', dataType: ['String'] },
      { name: 'description', dataType: 'StringWithEmpty' },
      { name: 'weblink', dataType: 'StringWithEmpty' },
      { name: 'image', dataType: 'base64Image' },
      { name: 'exposure', allowedValues: Box.BOX_VALID_EXPOSURES },
      { name: 'mqtt', dataType: 'object' },
      { name: 'ttn', dataType: 'object' },
      { name: 'sensors', dataType: ['object'] },
      { name: 'addons', dataType: 'object' },
      { predef: 'location' },
      { name: 'useAuth', allowedValues: ['true', 'false'] },
      { name: 'generate_access_token', allowedValues: ['true', 'false'] },
    ]),
    checkPrivilege,
    updateBox,
  ],
  // no auth required
  getBoxLocations: [
    retrieveParameters([
      { predef: 'boxId', required: true },
      {
        name: 'format',
        defaultValue: 'json',
        allowedValues: ['json', 'geojson'],
      },
      { predef: 'toDate' },
      { predef: 'fromDate' },
      validateFromToTimeParams,
    ]),
    getBoxLocations,
  ],
  postNewBox: [
    checkContentType,
    retrieveParameters([
      { name: 'name', required: true },
      { name: 'grouptag', dataType: ['String'], aliases: ['tag'] },
      { name: 'exposure', allowedValues: Box.BOX_VALID_EXPOSURES },
      { name: 'model', allowedValues: Box.BOX_VALID_MODELS },
      { name: 'sensors', dataType: ['object'] },
      {
        name: 'sensorTemplates',
        dataType: ['String'],
        allowedValues: [
          'hdc1080',
          'bmp280',
          'sds 011',
          'tsl45315',
          'veml6070',
          'bme680',
          'smt50',
          'soundlevelmeter',
          'windspeed',
          'scd30',
          'dps310',
          'sps30'
        ],
      },
      {
        name: 'serialPort',
        dataType: 'String',
        defaultValue: 'Serial1',
        allowedValues: ['Serial1', 'Serial2'],
      },
      {
        name: 'soilDigitalPort',
        dataType: 'String',
        defaultValue: 'A',
        allowedValues: ['A', 'B', 'C'],
      },
      {
        name: 'soundMeterPort',
        dataType: 'String',
        defaultValue: 'B',
        allowedValues: ['A', 'B', 'C'],
      },
      {
        name: 'windSpeedPort',
        dataType: 'String',
        defaultValue: 'C',
        allowedValues: ['A', 'B', 'C'],
      },
      { name: 'mqtt', dataType: 'object' },
      { name: 'ttn', dataType: 'object' },
      { name: 'useAuth', allowedValues: ['true', 'false'] },
      { predef: 'location', required: true },
      { name: 'sharedBox', allowedValues: ['true', 'false'] }
    ]),
    postNewBox,
  ],
  getBox: [
    retrieveParameters([
      { predef: 'boxId', required: true },
      {
        name: 'format',
        defaultValue: 'json',
        allowedValues: ['json', 'geojson'],
      },
    ]),
    getBox,
  ],
  getBoxes: [
    retrieveParameters([
      { name: 'name', dataType: 'String' },
      { name: 'limit', dataType: 'Number', defaultValue: 5, min: 1, max: 20 },
      {
        name: 'exposure',
        allowedValues: Box.BOX_VALID_EXPOSURES,
        dataType: ['String'],
      },
      { name: 'model', dataType: ['StringWithEmpty'] },
      { name: 'grouptag', dataType: ['StringWithEmpty'] },
      { name: 'phenomenon', dataType: 'StringWithEmpty' },
      { name: 'date', dataType: ['RFC 3339'] },
      {
        name: 'format',
        defaultValue: 'json',
        allowedValues: ['json', 'geojson'],
      },
      {
        name: 'classify',
        defaultValue: 'false',
        allowedValues: ['true', 'false'],
      },
      {
        name: 'minimal',
        defaultValue: 'false',
        allowedValues: ['true', 'false'],
      },
      { name: 'full', defaultValue: 'false', allowedValues: ['true', 'false'] },
      { predef: 'near' },
      { name: 'maxDistance' },
      { predef: 'bbox' },
    ]),
    parseAndValidateTimeParamsForFindAllBoxes,
    addCache('5 minutes', 'getBoxes'),
    getBoxes,
  ],
};
