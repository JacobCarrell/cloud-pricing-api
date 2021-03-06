import fs from 'fs';
import _ from 'lodash';
import axios, { AxiosResponse } from 'axios';
import glob from 'glob';
import config from '../config';
import { Product, Price } from '../db/types';
import { generateProductHash, generatePriceHash } from '../db/helpers';
import { upsertProducts } from '../db/upsert';

const baseUrl = 'https://prices.azure.com/api/retail/prices';

type ItemsJson = {
    Items: ProductJson[];
    nextPageToken: string;
};

type ProductJson = {
    currencyCode: string;
    effectiveStartDate: string;
    retailPrice: string;
    unitPrice: string;
    armRegionName: string;
    location: string;
    productId: string;
    skuId: string;
    productName: string;
    skuName: string;
    serviceName: string;
    serviceId: string;
    serviceFamily: string;
    unitOfMeasure: string;
    type: string;
    isPrimaryMeterRegion: boolean;
    armSkuName: string;
};

async function update(): Promise<void> {
    await download();
    await load();
}

async function download(): Promise<void> {
    config.logger.info(`Downloading Items...`);

    let resp: AxiosResponse | null = null;
    let success = false;
    let attempts = 0;

    do {
        try {
            attempts++;
            resp = await axios({
                method: 'get',
                url: `${baseUrl}`,
                responseType: 'stream',
            });
            success = true;
        } catch (err) {
            // Too many requests, sleep and retry
            if (err.response.status === 429) {
                config.logger.info(
                    'Too many requests, sleeping for 30s and retrying'
                );
                await sleep(30000);
            } else {
                throw err;
            }
        }
    } while (!success && attempts < 3);

    if (!resp) {
        return;
    }

    let filename = `az-items`;
    filename = filename.replace(/\//g, '-');
    filename = filename.replace(/\./g, '-');

    filename = `data/${filename}.json`;
    const writer = fs.createWriteStream(filename);
    resp.data.pipe(writer);
    await new Promise((resolve) => {
        writer.on('finish', resolve);
    });
    config.logger.info(`Downloaded json file.`);

}

async function load(): Promise<void> {
    config.logger.info(`Loading Items...`);
    for (const filename of glob.sync('data/az-items.json')) {
        try {
            await processFile(filename);
        } catch (e) {
            config.logger.error(`Skipping file ${filename} due to error ${e}`);
            config.logger.error(e.stack);
        }
    }
}

async function processFile(filename: string): Promise<void> {
    config.logger.info(`Processing File ${filename}`);
    const body = fs.readFileSync(filename);
    const json = <ItemsJson>JSON.parse(body.toString());

    const products = Object.values(json.Items).map((productJson) => {
        const product = parseProduct(productJson);
        return product;
    });

    await upsertProducts(products);
}

function parseProduct(productJson: ProductJson): Product {
    const product: Product = {
        productHash: '',
        sku: productJson.skuId,
        vendorName: 'azure',
        region: productJson.location,
        service: productJson.serviceName,
        productFamily: productJson.serviceFamily,
        attributes: {
            type: productJson.type
        },
        prices: [],
    };

    product.productHash = generateProductHash(product);
    product.prices = parsePrices(product, productJson);

    return product;
}

function parsePrices(product: Product, productJson: ProductJson): Price[] {
    const prices: Price[] = [];

            const price: Price = {
                priceHash: '',
                purchaseOption: productJson.type,
                unit: productJson.unitOfMeasure,
                USD: `${productJson.unitPrice}`,
                effectiveDateStart: productJson.effectiveStartDate,
                startUsageAmount: productJson.retailPrice
            };

            price.priceHash = generatePriceHash(product, price);

            prices.push(price);

    return prices;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
    update,
};
