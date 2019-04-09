const _ = require('underscore');
const Apify = require('apify');
const utils = require('apify-shared/utilities');

// This function normalizes the URL and removes the #fragment
const normalizeUrl = (url) => {
    const nurl = utils.normalizeUrl(url);
    if (nurl) return nurl;

    const index = url.indexOf('#');
    if (index > 0) return url.substring(0, index);

    return url;
};

Apify.main(async () => {
    // Fetch input
    const input = await Apify.getValue('INPUT');
    console.log('Input:');
    console.dir(input);

    const baseUrl = normalizeUrl(input.baseUrl);

    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({ url: baseUrl });

    const purlBase = new Apify.PseudoUrl(`${baseUrl}[(|/.*)]`);

    console.log(`Starting crawl of ${baseUrl}`);

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestsPerCrawl: input.maxPages,
        maxRequestRetries: 3,
        maxConcurrency: input.maxConcurrency,
        launchPuppeteerFunction: async () => Apify.launchPuppeteer({
            defaultViewport: {
                width: 1200,
                height: 900,
            },
        }),
        handlePageFunction: async ({ request, page, response }) => {
            await page.setRequestInterception(true);

            page.on('request', request => {
              if (request.url().endsWith('.pdf')) {
                request_client({
                  uri: request.url(),
                  encoding: null,
                  headers: {
                    'Content-type': 'applcation/pdf',
                  },
                }).then(response => {
                  console.log(response); // PDF Buffer
                  request.abort();
                });
              } else{
                request.continue();
              }
            });        

            if (request.url == "https://www.tvo.org/more"){
                request = null;
                record = null;
            } else {

                const url = normalizeUrl(request.url);
                console.log(`Analysing page: ${url}`);

                const record = {
                    url,
                    isBaseWebsite: false,
                    httpStatus: response.status(),
                    title: await page.title(),
                    linkUrls: null,
                    anchors: null,
                };

                if (response.status() !== 200) {
                    console.log('ALERT');
                    console.dir(request);
                    console.dir(record);
                    console.dir(response);
                }

                // If we're on the base website, find links to new pages and enqueue them
                if (purlBase.matches(url)) {
                    record.isBaseWebsite = true;
                    console.log(`[${url}] Enqueuing links`);
                    const infos = await Apify.utils.enqueueLinks({
                    page,
                    requestQueue,
                    selector: 'a:not([href^="mailto"]):not([href^="javascript"])',
                    });
                    let links = _.map(infos, (info) => info.request.url).sort();
                    record.linkUrls = _.uniq(links, true);
                }

                // Find all HTML element IDs and <a name="xxx"> anchors,
                // basically anything that can be addressed by #fragment
                record.anchors = await page.evaluate(() => {
                    const anchors = [];
                    document.querySelectorAll('body a[name]').forEach((elem) => {
                        const name = elem.getAttribute('name');
                        if (name) anchors.push(name);
                    });
                    document.querySelectorAll('body [id]').forEach((elem) => {
                        const id = elem.getAttribute('id');
                        if (id) anchors.push(id);
                    });
                    return anchors;
                });
                record.anchors.sort();
                record.anchors = _.uniq(record.anchors, true);

                // Save results
                await Apify.pushData(record);
            }
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            const url = normalizeUrl(request.url);
            console.log(`Page failed ${request.retryCount + 1} times, giving up: ${url}`);

            await Apify.pushData({
                url,
                httpStatus: null,
                errorMessage: _.last(request.errorMessages) || 'Unkown error',
            });
        },
    });

    await crawler.run();

    console.log('Crawling finished, processing results...');

    // Create a look-up table for normalized URL->record,
    // and also create a look-up table in record.anchorsDict for anchor->true
    const urlToRecord = {};
    const dataset = await Apify.openDataset();
    await dataset.forEach(async (record) => {
        urlToRecord[record.url] = record;
        record.anchorsDict = {};
        _.each(record.anchors, (anchor) => {
            record.anchorsDict[anchor] = true;
        });
    });

    // Array of normalized URLs to process
    const pendingUrls = [
        normalizeUrl(input.baseUrl),
    ];
    // Dictionary of finished URLs. Key is normalized URL, value true if URL was already processed
    const doneUrls = {};
    const results = [];

    while (pendingUrls.length > 0) {
        const url = pendingUrls.shift();

        // Only process each URL once
        if (doneUrls[url]) continue;
        doneUrls[url] = true;

        console.log(`Processing result: ${url}`);

        const record = urlToRecord[url];

        const result = {
            url,
            title: record.title,
            links: [],
        };
        results.push(result);

        for (let linkUrl of record.linkUrls) {
            const linkNurl = normalizeUrl(linkUrl);

            // Get fragment from URL
            const index = linkUrl.indexOf('#');
            const fragment = index > 0 ? linkUrl.substring(index+1) : '';

            const link = {
                url: linkUrl,
                normalizedUrl: linkNurl,
                httpStatus: null,
                errorMessage: null,
                fragment,
                fragmentValid: false,
                crawled: false,
            };

            const record = urlToRecord[linkNurl];
            if (!record) {
                // Page was not crawled at all...
                result.links.push(link);
                continue;
            }

            link.crawled = true;
            link.httpStatus = record.httpStatus;
            link.errorMessage = record.errorMessage;
            link.fragmentValid = !fragment || !!record.anchorsDict[fragment];
            result.links.push(link);

            // If the linked page is from the base website, add it to the processing queue
            if (record.isBaseWebsite && !doneUrls[linkNurl]) {
                pendingUrls.push(linkNurl);
            }
        }
    }

    // Save results in JSON format
    console.log('Saving results...');
    await Apify.setValue('OUTPUT', results);

    // Generate HTML report
    let html = `
<html>
  <head>
    <title>Broken link report for ${baseUrl}</title>
    <style>
        body {
            font-family : Sans-serif;
        }
        th {
            text-align: left;
        }
    </style>
  </head>
  <body>
    <table>
      <tr>
        <th>From</th>
        <th>To</th>
        <th>HTTP&nbsp;status</th>
        <th>Description</th>
      </tr>`;

    for (let result of results) {
        for (let link of result.links) {

        let color = 'lightgreen';
        let description = 'OK';
        if (!link.crawled) {
            color = '#F0E68C';
            description = 'Page not crawled';
        } else if (link.errorMessage || !link.httpStatus || link.httpStatus < 200 || link.httpStatus >= 300) {
            color = 'red';
            description = link.errorMessage ? `Error: ${link.errorMessage}` : 'Invalid HTTP status';
        } else if (!link.fragmentValid) {
            color = 'orange';
            description = 'URL fragment not found';
        }
        if (link.httpStatus !== 200){
            html += `<tr style="background-color: ${color}">
                <td><a href="${result.url}" target="_blank">${result.url}</a></td>
                <td><a href="${link.url}" target="_blank">${link.url}</a></td>
                <td>${link.httpStatus || ''}</td>
                <td>${description}</td>
            </tr>`;
        }
        }
    }

    html += `
    </table>
  </body>
</html>`;

    await Apify.setValue('OUTPUT.html', html, { contentType: 'text/html' });

    console.log('HTML report was stored to:');
    console.log(`https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/OUTPUT.html?disableRedirect=1`);

    console.log('\nDone.');
});
