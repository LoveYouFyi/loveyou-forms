// SECTION Requirements

// Cloud Functions for Firebase SDK to create Cloud Functions and setup triggers.
const functions = require('firebase-functions');
// Firebase Admin SDK to access the Firebase/Firestore Realtime Database.
const admin = require('firebase-admin');
/** [START] DATABASE CREDENTIALS ****/
const serviceAccount = require('./service-account.json'); // download from firebase console
admin.initializeApp({ // initialize firebase admin with credentials
  credential: admin.credential.cert(serviceAccount), // So functions can connect to database
  databaseURL: 'https://loveyou-forms.firebaseio.com' // Needed if using FireBase database (not FireStore)
});
/** [END] DATABASE CREDENTIALS ****/
const db = admin.firestore(); // FireStore database reference
// Timestamps: required for adding server-timestamps to any database docs
const FieldValue = require('firebase-admin').firestore.FieldValue; // Timestamp here
const timestampSettings = { timestampsInSnapshots: true}; // Define timestamp settings
db.settings(timestampSettings); // Apply timestamp settings to database settingsA
/** [IMPORTANT] If not sending data to Google Sheets, omit remaining requirements */
/** [START] firestoreToSheets Function Support ****/
const moment = require('moment-timezone'); // Timestamp formats and timezones
const { google } = require('googleapis');
const sheets = google.sheets('v4'); // Google Sheets
const jwtClient = new google.auth.JWT({ // JWT Authentication (for google sheets)
  email: serviceAccount.client_email, // [**** CREDENTIALS ****]
  key: serviceAccount.private_key, // [**** CREDENTIALS ****]
  scopes: ['https://www.googleapis.com/auth/spreadsheets'] // read and write sheets
});
/** [END] firestoreToSheets Function Support ****/

// !SECTION

// SECTION Utility Functions

const logErrorInfo = error => ({
  Error: 'Description and source line:',
  description: error,
  break: '**************************************************************',
  Logger: ('Error reported by log enty at:'),
  info: (new Error()),
});

// !SECTION

// Terminate HTTP functions with res.redirect(), res.send(), or res.end().
// https://firebase.google.com/docs/functions/terminate-functions


// ANCHOR Form Handler
exports.formHandler = functions.https.onRequest(async (req, res) => {
  
  let messages;

  try {

    /**
     *  Check if Authorized App and if Form submit disabled:
     *  Stop processing if form not submitted by authorized app, or submit disabled
     */
    
    const reqBody = JSON.parse(req.body); // ajax sent as json-string, so must parse

    const appRef = await db.collection('app').doc(reqBody.appKey.value).get();
    const app = appRef.data();

    // App key: if exists continue with global and app condition checks
    if (app) {
      const globalAppRef = await db.collection('global').doc('app').get();
      const globalApp = globalAppRef.data();
      // set messages to globalApp or app-specific
      if (app.condition.messageGlobal || app.condition.messageGlobal == null) {
        messages = globalApp.message;
      } else {
        messages = app.message;
      }
      // CORS validation: stop cloud function if CORS check does not pass
      // global boolean 0/1, if set to 2 bypass global & use app-specific boolean
      if (!globalApp.condition.corsBypass
          || (globalApp.condition.corsBypass === 2 && !app.condition.corsBypass)
        ) {
        // restrict to url requests that match the app
        res.set('Access-Control-Allow-Origin', app.appInfo.appUrl);
        // end processing if url does not match (req.headers.origin = url)
        if (req.headers.origin !== app.appInfo.appUrl) { 
          console.info(new Error('Origin Url does not match app url.'));
          // no error response sent because submit not from approved app
          return res.end();
        }
      } else {
        // allow * so localhost (or any source) recieves response
        res.set('Access-Control-Allow-Origin', '*');
      }
      // Form Submit Enabled/Disabled: stop cloud function if submitForm disabled
      // global boolean 0/1, if set to 2 bypass global & use app-specific boolean
      if (!globalApp.condition.submitForm
          || (globalApp.condition.submitForm === 2 && !app.condition.submitForm)
        ) {
        console.info(new Error(`Form submit disabled for app "${app.appInfo.appName}"`));
        // return error response because submit is from approved app
        throw (globalApp.message.error.text);
      }
    } else {
      console.info(new Error('App Key does not exist.'));
      // no error response sent because submit not from approved app
      return res.end();
    }


    /**
     * Fields/Props
     * Compile fields (app props & form fields) labeled 'props' because they are handled 
     * as object entries; sanitize; add to structured object; submit to databasea
     */

    const appKey = app.id;
    const appInfoObject = app.appInfo;

    // Dynamic Default Form Fields
    // 1) query array global.formFieldName.defaultFields
    // 2) if array not empty -> .getAll() array fields from formFieldName

    // Global Field Defaults
    const globalFormFieldNameDefaultsRef = await db.collection('global').doc('formFieldName').get();
    const globalFormFieldNameDefaults = globalFormFieldNameDefaultsRef.data().defaults;
    const formFieldNameGlobalsRefs = globalFormFieldNameDefaults.map(id => 
      db.collection('formFieldName').doc(id));
    const formFieldNameGlobalsGetAll = await db.getAll(...formFieldNameGlobalsRefs);
    const formFieldNameGlobals = formFieldNameGlobalsGetAll.reduce((a, doc) => {
      a[doc.id] = doc.data();
      return a;
    }, {});

    const { ...form } = reqBody; // destructure reqBody json object
    console.log("form #################################### ", form);

    // Consolidate props (order-matters) last-in overwrites previous 
    const props = { appKey, ...formFieldNameGlobals, ...form, ...appInfoObject };
    console.log("props $$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$ ", props);
    
    // Unique Prop Types
    const propsFields = { ...formFieldNameGlobals, ...form }
    const uniqueFieldTypes = Object.entries(propsFields).reduce((a, [key, value]) => {
      if (!a.includes(value['type']) && typeof value['type'] !== 'undefined' ) { 
        a.push(value['type']); 
      }
      return a;
    }, []);
    console.log("uniqueType $$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$ ", uniqueFieldTypes); 

    // Return array of query doc refs for firestore .getAll()
    const formFieldDocsRefs = Object.keys(props).map(id => 
      db.collection('formFieldName').doc(id));
    // Retrieve selected docs using array of query doc refs
    const formFieldDocsGetAll = await db.getAll(...formFieldDocsRefs);
    // Return array of docs that exist and have data
    const formFieldDocs =  formFieldDocsGetAll.reduce((a, doc) => {
      doc.data() && a.push({ id: doc.id, ...doc.data() }); // if doc.data() exists -> push
      return a;
    }, []);
    console.log("formFieldsDocs ####################################### ", formFieldDocs);

    /** [START] Data Validation & Set Props ***********************************/
    // field may contain maxLength values to override defaults in global.fieldDefault.typeMaxLength
    const fieldsMaxLength = formFieldDocs.reduce((a, doc) => {
      if (doc.maxLength) {
        a[doc.id] = doc.maxLength;
      } 
      return a;
    }, {});
    console.log("fieldsMaxLength ############################## ", fieldsMaxLength);

    // Whitelist for adding props to submitForm entry's template.data for 'trigger email' extension
    const whitelistTemplateDataRef = await db.collection('formTemplate').doc(props.templateName.value).get();
    const whitelistTemplateData = whitelistTemplateDataRef.data();

    const propsSet = (() => { 

      const sanitize = (value, maxLength) => 
        value.toString().trim().substr(0, maxLength);

      // compare database fields with form-submitted props and build object
      const getProps = Object.entries(props).reduce((a, [prop, data]) => {
        let sanitized, maxLength;
        if (appInfoObject.hasOwnProperty(prop)) {
          sanitized = data;
        } else {
          // form prop will be undefined if form does not include element, so using global config
          if (fieldsMaxLength[prop]) { 
            maxLength = fieldsMaxLength[prop];
            sanitized = sanitize(data.value, maxLength);
          } else if (!fieldsMaxLength[prop] && globalFieldDefault.typeMaxLength[data.type]) {
            maxLength = globalFieldDefault.typeMaxLength[data.type];
            sanitized = sanitize(data.value, maxLength);
          }
        }
        // add to object {}
        a[prop] = sanitized;
        // if 'prop' in templateData whitelist, add to object templateData 
        if (whitelistTemplateData.templateData.includes(prop)) {
          // add to object {} prop: templateData object
          a.templateData[prop] = sanitized; 
        } 

        return a
      }, { templateData: {} });

      return {
        get: () => {
          return getProps;
        }
      }
    })();
    /** [END] Data Validation & Set Props *************************************/

    const propsGet = ({ templateData, urlRedirect, ...key } = propsSet.get()) => ({
      data: {
        appKey: key.appKey, 
        createdDateTime: FieldValue.serverTimestamp(), 
        from: key.appFrom, 
        toUids: [ key.appKey ], 
        replyTo: templateData.email,
        webformId: key.webformId, 
        template: { 
          name: key.templateName, 
          data: templateData
        }
      },
      urlRedirect: urlRedirect
    });

    // For serverTimestamp to work must first create new doc key then 'set' data
    const newKeyRef = db.collection('submitForm').doc();
    // update the new-key-record using 'set' which works for existing doc
    newKeyRef.set(propsGet().data)

    /**
     * Response
     */
 
    // return response object (even if empty) so client can finish AJAX success
    return res.status(200).send({
      data: {
        redirect: propsGet().urlRedirect,
        message: messages.success
      }
    });

  } catch(error) {
    
    console.error(logErrorInfo(error));

    return res.status(500).send({
      error: {
        message: messages.error
      }
    });

  } // end catch

});


// ANCHOR - Firestore To Sheets [New sheet, header, and data row]
exports.firestoreToSheets = functions.firestore.document('submitForm/{formId}')
  .onCreate(async (snapshot, context) => {

  try {

    /**
    * Prepare row data values and sheet header
    */

    // Form Submission: values from Snapshot.data()
    const { appKey, createdDateTime, template: { data: { ...templateData }, 
      name: templateName  }, webformId } = snapshot.data();

    // Template: two sort-ordered arrays of strings
    // sheetHeader array is sorted according to desired sheets visual
    // templateData array is sorted to match the order of sheetHeader
    const formTemplateRef = await db.collection('formTemplate').doc(templateName).get();
    const formTemplate = formTemplateRef.data();

    // Header fields for sheet requires nested array of strings [ [ 'Date', 'Time', etc ] ]
    const sheetHeader = [( formTemplate.sheetHeader )]; 

    /** [START] Row Data: Sort & Merge ****************************************/
    // Strings to 'prop: value' objects so data to be merged has uniform format
    // timezone 'tz' string defined by momentjs.com/timezone: https://github.com/moment/moment-timezone/blob/develop/data/packed/latest.json
    const dateTime = createdDateTime.toDate(); // toDate() is firebase method
    const createdDate = moment(dateTime).tz(templateData.appTimeZone).format('L');
    const createdTime = moment(dateTime).tz(templateData.appTimeZone).format('h:mm A z');
    // Reduce array formTemplate.templateData, this returns an object that 
    // is sort-ordered to matach the sheetHeader fields.
    const templateDataSorted = formTemplate.templateData.reduce((a, c) => {
      templateData[c] ? a[c] = templateData[c] : a[c] = "";
      return a
    }, {});
    // Merge objects in sort-order and return only values
    // Data-row for sheet requires nested array of strings [ [ 'John Smith', etc ] ]
    const sheetDataRow = [( Object.values({ createdDate, createdTime, 
      webformId, ...templateDataSorted }) )];
    /** [END] Row Data: Sort & Merge ******************************************/


    /**
    * Prepare to insert data-row into app spreadsheet
    */

    // Get app spreadsheetId and sheetId (one spreadsheet with multiple sheets possible)
    const appRef = await db.collection('app').doc(appKey).get();
    const app = appRef.data();
    const spreadsheetId = app.spreadsheet.id; // one spreadsheet per app
    const sheetId = app.spreadsheet.sheetId[templateName]; // multiple possible sheets

    // Authorize with google sheets
    await jwtClient.authorize();

    // Row: Add to sheet (header or data)
    const rangeHeader =  `${templateName}!A1`; // e.g. "contactDefault!A1"
    const rangeData =  `${templateName}!A2`; // e.g. "contactDefault!A2"

    const addRow = range => values => ({
      auth: jwtClient,
      spreadsheetId: spreadsheetId,
      ...range && { range }, // e.g. "contactDefault!A2"
      valueInputOption: "RAW",
      requestBody: {
        ...values && { values }
      }
    });
    
    // Row: Blank insert (sheetId argument: existing vs new sheet)
    const blankRowInsertAfterHeader = sheetId => ({
      auth: jwtClient,
      spreadsheetId: spreadsheetId,
      resource: {
        requests: [
          {
            "insertDimension": {
              "range": {
                "sheetId": sheetId,
                "dimension": "ROWS",
                "startIndex": 1,
                "endIndex": 2
              },
              "inheritFromBefore": false
            }
          }
        ]
      }
    });

    /**
    * Insert row data into sheet that matches template name
    */

    // Check if sheet name exists for data insert
    const sheetObjectRequest = () => ({
      auth: jwtClient,
      spreadsheetId: spreadsheetId,
      includeGridData: false
    });
    const sheetDetails = await sheets.spreadsheets.get(sheetObjectRequest());
    const sheetNameExists = sheetDetails.data.sheets.find(sheet => {
      // if sheet name exists returns sheet 'properties' object, else is undefined
      return sheet.properties.title === templateName;
    });

    // If sheet name exists, insert data
    // Else, create new sheet + insert header + insert data
    if (sheetNameExists) {
      // Insert into spreadsheet a blank row and the new data row
      await sheets.spreadsheets.batchUpdate(blankRowInsertAfterHeader(sheetId));
      await sheets.spreadsheets.values.update(addRow(rangeData)(sheetDataRow));

    } else {
      // Create new sheet, insert heder and new row data
      
      // Request object for adding sheet to existing spreadsheet
      const addSheet = () => ({
        auth: jwtClient,
        spreadsheetId: spreadsheetId,
        resource: {
          requests: [
            {
              "addSheet": {
                "properties": {
                  "title": templateName,
                  "index": 0,
                  "gridProperties": {
                    "rowCount": 1000,
                    "columnCount": 26
                  },
                }
              } 
            }
          ]
        }
      });

      // Add new sheet:
      // 'addSheet' request object returns new sheet properties
      // Get new sheetId and add to app spreadsheet info
      // newSheet returns 'data' object with properties:
      //   prop: spreadsheetId
      //   prop: replies[0].addSheet.properties (sheetId, title, index, sheetType, gridProperties { rowCount, columnCount }
      const newSheet = await sheets.spreadsheets.batchUpdate(addSheet());
      // Map 'replies' array to get sheetId
      const newSheetId = sheet => {
        const newSheet = {};
        sheet.data.replies.map(reply => newSheet.addSheet = reply.addSheet);
        return newSheet.addSheet.properties.sheetId;
      };

      // Add new sheetId to app spreadsheet info
      db.collection('app').doc(appKey).update({
        ['spreadsheet.sheetId.' + templateName]: newSheetId(newSheet)
      });

      // New Sheet Actions: add row header then row data
      await sheets.spreadsheets.values.update(addRow(rangeHeader)(sheetHeader));
      await sheets.spreadsheets.values.update(addRow(rangeData)(sheetDataRow));

    } // end 'else' add new sheet

  } catch(error) {
    
    console.error(logErrorInfo(error));

  } // end catch

});


// ANCHOR Firebase to Sheets [Basic 2 Column List]
exports.firebaseToSheets = functions.database.ref('/Form')
  .onUpdate(async change => {

  let data = change.after.val();
  console.log("data ################ ", data);
  // Convert JSON to Array following structure below
  //
  //[
  //  ['COL-A', 'COL-B'],
  //  ['COL-A', 'COL-B']
  //]
  //
  let itemArray = [];
  let valueArray = [];
  Object.keys(data).forEach((key, index) => {
    itemArray.push(key);
    itemArray.push(data[key]);
    console.log("itemArray ############################# ", itemArray);
    valueArray[index] = itemArray;
    itemArray = [];
  });

  let maxRange = valueArray.length + 1;

  // Do authorization
  await jwtClient.authorize();
  console.log("valueArray ############################# ", valueArray) 

  // Create Google Sheets request
  let request = {
    auth: jwtClient,
    spreadsheetId: "1nOzYKj0Gr1zJPsZv-GhF00hUAJ2sTsCosMk4edJJ9nU",
    range: "Firebase!A2:B" + maxRange,
    valueInputOption: "RAW",
    requestBody: {
      values: valueArray
    }
  };
  
  // Update data to Google Sheets
  await sheets.spreadsheets.values.update(request, {});
});

