const pupHelper = require('./puppeteerhelper');
const _ = require('underscore');
const fs = require('fs');
const pLimit = require('p-limit');
const moment = require('moment');
const {dealerLink} = require('./keys');
let browser;
let productsLinks = [];
let products = [];

const scrapeSite = () => new Promise(async (resolve, reject) => {
  try {
    console.log('Started Scraping...');

    // Launch The Browser
    browser = await pupHelper.launchBrowser();

    // Fetch Links to individual Products
    await fetchProductsLinks();

    // Fetch Details of ads
    const limit = pLimit(5);
    const promises = [];
    // for (let i = 0; i < productsLinks.length; i++) {
    for (let i = 0; i < 200; i++) {
      promises.push(limit(() => fetchProductsDetails(i)));
    }
    await Promise.all(promises);
    fs.writeFileSync('products.json', JSON.stringify(products));

    // Save to Csv
    await saveToCsv();

    // Close the Browser
    await browser.close();
    console.log('Finished Scraping...');
    resolve(true);
  } catch (error) {
    if (browser) await browser.close();
    console.log(`Run Error: ${error}`);
    reject(error);
  }
})

const fetchProductsLinks = () => new Promise(async (resolve, reject) => {
  let page;
  try {
    console.log('Fetching Ads Links...');
    page = await pupHelper.launchPage(browser);
    await page.goto(dealerLink, {timeout: 0, waitUntil: 'networkidle2'});
    await page.waitForSelector('.mp-PaginationControls-pagination-pageList > span:last-child');
    const numberOfPages = Number(await pupHelper.getTxt('.mp-PaginationControls-pagination-pageList > span:last-child', page));
    console.log(`Number of Pages found for Dealer: ${numberOfPages}`);
    await page.close();

    // for (let i = 1; i <= numberOfPages; i++) {
    for (let i = 1; i <= 20; i++) {
      console.log(`Fetching Ads Links from page: ${i}/${numberOfPages}`);
      page = await pupHelper.launchPage(browser);
      await page.goto(`${dealerLink}p/${i}`, {timeout: 0, waitUntil: 'networkidle2'});
      await page.waitForSelector('ul.mp-Listings');
      let pageLinks = await pupHelper.getAttrMultiple('ul.mp-Listings > li.mp-Listing > a', 'href', page);
      pageLinks = pageLinks.map(pl => 'https://www.marktplaats.nl' + pl);
      
      productsLinks.push(...pageLinks);
      await page.close();
    }

    productsLinks = _.uniq(productsLinks);
    console.log(`Number of Products found with dealer: ${productsLinks.length}`);
    fs.writeFileSync('productsLinks.json', JSON.stringify(productsLinks));
    resolve(true);
  } catch (error) {
    if (page) await page.close();
    console.log('fetchProductsLinks Error: ', error);
    reject(error);
  }
});

const fetchProductsDetails = (prodIdx) => new Promise(async (resolve, reject) => {
  let page;
  try {
    const product = {};
    console.log(`${prodIdx+1}/${productsLinks.length} - Fetching Ad Details [${productsLinks[prodIdx]}]...`);
    page = await pupHelper.launchPage(browser);
    await page.goto(productsLinks[prodIdx], {timeout: 0, waitUntil: 'networkidle2'});
    await page.waitForSelector('#content');
    const isCar = await page.$('section.listing');

    if (isCar) {
      const specs = await fetchSpecs(page);
  
      product.url = productsLinks[prodIdx];
      product.title = await pupHelper.getTxt('h1#title', page);
      product.title = product.title.replace(/\*NU-OF-NOOIT\!\*/gi, '').trim();
      product.makeModel = await getCellVal('Merk & Model:', specs);
      product.year = await getCellVal('Bouwjaar:', specs);
      product.bodyType = await getCellVal('Carrosserie:', specs);
      product.fuelType = await getCellVal('Brandstof:', specs);
      product.mileage = await getCellVal('Kilometerstand:', specs);
      product.transmission = await getCellVal('Transmissie:', specs);
      product.price = await getCellVal('Prijs:', specs);
      product.price = product.price.replace(/^€/gi, '').trim().replace(/\./gi, '').trim().replace(/,/gi, '.').trim();
      product.engineCapacity = await getCellVal('Motorinhoud:', specs);
      product.options = await getCellVal('Opties:', specs);
      product.options = product.options.replace(/\n/gi, ' | ');
      product.licensePlateNumber = await getCellVal('Kenteken:', specs);
      product.apkDate = await getCellVal('APK tot:');

      product.customer = await pupHelper.getTxt('h2.name', page);
      product.location = await pupHelper.getTxt('#vip-seller-location > h3 > .name', page);
      product.images = await pupHelper.getAttrMultiple('#vip-image-viewer > .image > img', 'src', page);
      product.images = product.images.map(img => 'https:' + img);
      product.phone = '';
      
      // const hasPhoneButton = await page.$('.seller-block .contact-options-mobile button.mp-Button');
      const hasPhoneButton = await page.$('aside button[title="Toon telefoonnummer"]');
      if (hasPhoneButton) {
        await page.click('aside button[title="Toon telefoonnummer"]');
        // await page.waitForSelector('.seller-block .contact-options-mobile button.mp-Button .phone-number-bubble');
        await page.waitForSelector('aside button[title="Toon telefoonnummer"] .phone-number-bubble');
        product.phone = await pupHelper.getTxt('aside button[title="Toon telefoonnummer"] .phone-number-bubble', page);
      }
      
      for (const key in product) {
        if (typeof product[key] != 'object') {
          product[key] = product[key].replace(/\"/gi, "'");
        } 
      }
      console.log(product);
    
      products.push(product);
    } else {
      console.log('Not Found...');
    }

    await page.close();
    resolve(true);
  } catch (error) {
    if (page) await page.close();
    console.log(`fetchProductsDetails[${productsLinks[prodIdx]}] Error: `, error.message);
    resolve(false);
  }
});

const fetchSpecs = (page) => new Promise(async (resolve, reject) => {
  try {
    const specs = {};
    await page.waitForSelector('.spec-table > .spec-table-item');
    const specsCol = await page.$$('.spec-table > .spec-table-item');
    for (let i = 0; i < specsCol.length; i++) {
      const specLabel = await pupHelper.getTxt('.key', specsCol[i]);
      const specValue = await pupHelper.getTxt('.value', specsCol[i]);
      specs[specLabel.toLowerCase().trim()] = specValue.trim();
    }

    resolve(specs);
  } catch (error) {
    console.log('fetchSpecs Error: ', error);
    reject(error);
  }
});

const getCellVal = (label, specs) => new Promise(async (resolve, reject) => {
    try {
      let returnVal = '';
      for (const specLabel in specs) {
        if (specLabel == label.toLowerCase()) {
          returnVal = specs[specLabel];
        }
      }

      resolve(returnVal);
    } catch (error) {
      console.log(`getCellVal(${label}) Error: ${error}`);
      reject(error);
    }
});

const saveToCsv = () => new Promise(async (resolve, reject) => {
  try {
    console.log("Saving to csv...");
    const fileName = `results ${moment().format('MM-DD-YYYY HH-mm')}.csv`;
    const csvHeader = '"URL","Title","MakeModel","Year","Body Type","Fuel Type","Mileage","Transmission","Price","Engine Capacity","Options","License Plate Number","APK Date","Customer Name","Location","Phone Number","Image 1","Image 2","Image 3","Image 4","Image 5","Image 6","Image 7","Image 8","Image 9","Image 10","Image 11","Image 12","Image 13","Image 14"\r\n';
    fs.writeFileSync(fileName, csvHeader);

    for (let i = 0; i < products.length; i++) {
      let csvLine = '';
      csvLine += `"${products[i].url}"`;
      csvLine += `,"${products[i].title}"`;
      csvLine += `,"${products[i].makeModel}"`;
      csvLine += `,"${products[i].year}"`;
      csvLine += `,"${products[i].bodyType}"`;
      csvLine += `,"${products[i].fuelType}"`;
      csvLine += `,"${products[i].mileage}"`;
      csvLine += `,"${products[i].transmission}"`;
      csvLine += `,"${products[i].price}"`;
      csvLine += `,"${products[i].engineCapacity}"`;
      csvLine += `,"${products[i].options}"`;
      csvLine += `,"${products[i].licensePlateNumber}"`;
      csvLine += `,"${products[i].apkDate}"`;
      csvLine += `,"${products[i].customer}"`;
      csvLine += `,"${products[i].location}"`;
      csvLine += `,"${products[i].phone}"`;
      csvLine +=  products[i].images[0] ? `,"${products[i].images[0]}"` : ',""';
      csvLine +=  products[i].images[1] ? `,"${products[i].images[1]}"` : ',""';
      csvLine +=  products[i].images[2] ? `,"${products[i].images[2]}"` : ',""';
      csvLine +=  products[i].images[3] ? `,"${products[i].images[3]}"` : ',""';
      csvLine +=  products[i].images[4] ? `,"${products[i].images[4]}"` : ',""';
      csvLine +=  products[i].images[5] ? `,"${products[i].images[5]}"` : ',""';
      csvLine +=  products[i].images[6] ? `,"${products[i].images[6]}"` : ',""';
      csvLine +=  products[i].images[7] ? `,"${products[i].images[7]}"` : ',""';
      csvLine +=  products[i].images[8] ? `,"${products[i].images[8]}"` : ',""';
      csvLine +=  products[i].images[9] ? `,"${products[i].images[9]}"` : ',""';
      csvLine +=  products[i].images[10] ? `,"${products[i].images[10]}"` : ',""';
      csvLine +=  products[i].images[11] ? `,"${products[i].images[11]}"` : ',""';
      csvLine +=  products[i].images[12] ? `,"${products[i].images[12]}"` : ',""';
      csvLine +=  products[i].images[13] ? `,"${products[i].images[13]}"` : ',""';
      csvLine += "\r\n";
      fs.appendFileSync(fileName, csvLine);
    }

    resolve(true);
  } catch (error) {
    console.log('saveToCsv Error: ', error);
    reject(error);
  }
});

(async () => {
  await scrapeSite();
})()