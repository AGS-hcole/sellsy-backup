const schedule = require("node-schedule");
const Fs = require("fs");
const Https = require("https");
const archiver = require("archiver");
const findRemoveSync = require("find-remove");
const dotenv = require("dotenv");

// Load the environment variables from the .env file
dotenv.config();

const API_URL = process.env.SELLSY_API_URL;
const LOGIN_URL = process.env.SELLSY_LOGIN_URL;
const PATH = process.env.LOCAL_PATH;
const MAXIMUM_HOLD_IN_DAYS = process.env.MAXIMUM_HOLD_IN_DAYS;
const IS_SCHEDULED = process.env.IS_SCHEDULED;
const SCHEDULE_PATTERN = process.env.SCHEDULE_PATTERN;

if (IS_SCHEDULED == "true") {
  const job = schedule.scheduleJob(SCHEDULE_PATTERN, backupSellsy);
} else {
  backupSellsy();
}

async function backupSellsy() {
  const token = await getToken();
  const companies = await fetchAll(API_URL + "/v2/companies", token);
  const contacts = await fetchAll(API_URL + "/v2/contacts", token);
  const invoices = await fetchAll(API_URL + "/v2/invoices", token);
  const creditNotes = await fetchAll(API_URL + "/v2/credit-notes", token);
  const subscriptions = await fetchAll(API_URL + "/v2/subscriptions", token);

  await saveInvoices(invoices);
  await saveInvoices(creditNotes);
  await saveAll(companies, contacts, invoices, creditNotes, subscriptions);
  await clearOldBackups();
}

/**
 * Method to save all the data into one zip file
 */
async function saveAll(
  companies,
  contacts,
  invoices,
  creditNotes,
  subscriptions
) {
  // Saving JSON to files
  Fs.writeFileSync(
    formatPath(PATH, `/companies.json`),
    JSON.stringify(companies),
    {
      overwrite: true,
    }
  );
  Fs.writeFileSync(
    formatPath(PATH, `/contacts.json`),
    JSON.stringify(contacts),
    {
      overwrite: true,
    }
  );
  Fs.writeFileSync(
    formatPath(PATH, `/invoices.json`),
    JSON.stringify(invoices),
    {
      overwrite: true,
    }
  );
  Fs.writeFileSync(
    formatPath(PATH, `/credit-notes.json`),
    JSON.stringify(creditNotes),
    {
      overwrite: true,
    }
  );
  Fs.writeFileSync(
    formatPath(PATH, `/subscriptions.json`),
    JSON.stringify(subscriptions),
    { overwrite: true }
  );

  //Retrieving stream from JSON files
  companiesStream = Fs.createReadStream(formatPath(PATH, `/companies.json`));
  contactsStream = Fs.createReadStream(formatPath(PATH, `/contacts.json`));
  invoicesStream = Fs.createReadStream(formatPath(PATH, `/invoices.json`));
  creditNotesStream = Fs.createReadStream(
    formatPath(PATH, `/credit-notes.json`)
  );
  subscriptionsStream = Fs.createReadStream(
    formatPath(PATH, `/subscriptions.json`)
  );

  // Creating the ZIP archive
  const outputfile = formatPath(
    PATH,
    `/backups/sellsy-backup-${new Date().toJSON().slice(0, 10)}.zip`
  );
  const outputStream = Fs.createWriteStream(outputfile);
  const archive = archiver("zip", {
    zlib: { level: 9 },
  });

  if (!Fs.existsSync(formatPath(PATH, "/backups"))) {
    Fs.mkdirSync(formatPath(PATH, "/backups"));
  }

  // Adding files to ZIP archive and write to disk
  archive.pipe(outputStream);
  archive.append(companiesStream, { name: "companies.json" });
  archive.append(contactsStream, { name: "contacts.json" });
  archive.append(invoicesStream, { name: "invoices.json" });
  archive.append(creditNotesStream, { name: "credit-notes.json" });
  archive.append(subscriptionsStream, { name: "subscriptions.json" });
  await archive.finalize();
}

/**
 * Method to clear zip files older than 30 days
 */
async function clearOldBackups() {
  findRemoveSync(formatPath(PATH, "/backups"), {
    extensions: [".zip"],
    age: { seconds: MAXIMUM_HOLD_IN_DAYS * 24 * 60 * 60 },
  });
  findRemoveSync(PATH, {
    extensions: [".json"],
    maxLevel: 1,
  });
}

/**
 * Method to parse all invoices returned and save them one by one as PDF file
 */
async function saveInvoices(documents) {
  await Promise.all(
    documents.map(async (document) => {
      console.log("downloading: " + document.pdf_link);
      await downloadFile(
        document.pdf_link,
        formatPath(PATH, "/invoices/" + document.number + ".PDF")
      );
    })
  );
}

/**
 * Authentifcation method to retrieve the token from Sellsy APIs
 *
 * @returns {string}
 */
async function getToken() {
  const body = {
    client_id: process.env.SELLSY_CLIENT_ID,
    client_secret: process.env.SELLSY_CLIENT_SECRET,
    grant_type: "client_credentials",
  };
  const response = await fetch(LOGIN_URL + "/oauth2/access-tokens", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!response.ok) null;

  const authorization = await response.json();

  return authorization.access_token;
}

async function fetchAll(url, token, data = [], offset = 0, limit = 100) {
  console.log(`${url}?limit=${limit}&offset=${offset}`);
  return await fetch(`${url}?limit=${limit}&offset=${offset}`, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  })
    .then((response) => response.json())
    .then(async (sData) => {
      const response = [...data, ...sData.data];

      if (
        sData.pagination.offset + sData.pagination.count <
        sData.pagination.total
      ) {
        return await fetchAll(
          url,
          token,
          response,
          sData.pagination.offset + sData.data.length,
          limit
        );
      }

      return response;
    });
}

/**
 * Download a file from the given `url` into the `targetFile`.
 *
 * @param {String} url
 * @param {String} targetFile
 *
 * @returns {Promise<void>}
 */
async function downloadFile(url, targetFile) {
  return await new Promise((resolve, reject) => {
    Https.get(url, (response) => {
      const code = response.statusCode ?? 0;

      if (code >= 400) {
        return reject(new Error(response.statusMessage));
      }

      // handle redirects
      if (code > 300 && code < 400 && !!response.headers.location) {
        return resolve(downloadFile(response.headers.location, targetFile));
      }

      // save the file to disk
      const fileWriter = Fs.createWriteStream(targetFile).on("finish", () => {
        resolve({});
      });

      response.pipe(fileWriter);
    }).on("error", (error) => {
      reject(error);
    });
  });
}

function formatPath(path, value) {
  const isLinux = path.includes("/");

  if (isLinux) {
    return (path + value).replace("\\", "/");
  } else {
    return (path + value).replace("/", "\\");
  }
}
