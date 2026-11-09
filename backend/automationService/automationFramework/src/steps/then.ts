import { Then } from '@cucumber/cucumber';

import checkClass from '../support/check/checkClass.js';
import checkContainsAnyText from '../support/check/checkContainsAnyText.js';
import checkIsEmpty from '../support/check/checkIsEmpty.js';
import checkContainsText from '../support/check/checkContainsText.js';
import checkCookieContent from '../support/check/checkCookieContent.js';
import checkCookieExists from '../support/check/checkCookieExists.js';
import checkDimension from '../support/check/checkDimension.js';
import checkEqualsText from '../support/check/checkEqualsText.js';
import checkFocus from '../support/check/checkFocus.js';
import checkInURLPath from '../support/check/checkInURLPath.js';
import checkIsOpenedInNewWindow from
    '../support/check/checkIsOpenedInNewWindow.js';
import checkModal from '../support/check/checkModal.js';
import checkModalText from '../support/check/checkModalText.js';
import checkNewWindow from '../support/check/checkNewWindow.js';
import checkOffset from '../support/check/checkOffset.js';
import checkProperty from '../support/check/checkProperty.js';
import checkFontProperty from '../support/check/checkFontProperty.js';
import checkSelected from '../support/check/checkSelected.js';
import checkTitle from '../support/check/checkTitle.js';
import checkTitleContains from '../support/check/checkTitleContains.js';
import checkURL from '../support/check/checkURL.js';
import checkURLPath from '../support/check/checkURLPath.js';
import checkWithinViewport from '../support/check/checkWithinViewport.js';
import compareText from '../support/check/compareText.js';
import isEnabled from '../support/check/isEnabled.js';
import isExisting from '../support/check/isExisting.js';
import isVisible from '../support/check/isDisplayed.js';
import waitFor from '../support/action/waitFor.js';
import waitForVisible from '../support/action/waitForDisplayed.js';
import checkIfElementExists from '../support/lib/checkIfElementExists.js';
import {setRequest} from '../support/api/setRequest.js'
import {postRequest} from '../support/api/request.js'
import { setHeader } from '../support/api/setHeaders.js';

Then(
    'I expect that the title is{string}',
    checkTitle
);

Then(
    'requestBody {string}',
    setRequest
);

Then(
    'requestHeader {string}',
    setHeader 
);

Then(
    'method {string}',
    postRequest
);

Then(
    'I expect that the title{string} contains {string}',
    checkTitleContains
);

Then(
    'I expect that element {string} does{string} appear exactly {int} times',
    checkIfElementExists
);

Then(
    'I expect that element {string} is{string} displayed',
    isVisible
);

Then(
    'I expect that element {string} becomes{string} displayed',
    waitForVisible
);

Then(
    'I expect that element {string} is{string} within the viewport',
    checkWithinViewport
);

Then(
    'I expect that element {string} does{string} exist',
    isExisting
);

Then(
    'I expect that element {string}{string} contains the same text as element {string}',
    compareText
);

Then(
    'I expect that {word} {string}{string} matches the text {string}',
    checkEqualsText
);

Then(
    'I expect that {word} {string}{string} contains the text {string}',
    checkContainsText
);

Then(
    'I expect that {word} {string}{string} contains any text',
    checkContainsAnyText
);

Then(
    'I expect that {word} {string} is{string} empty',
    checkIsEmpty
);

Then(
    'I expect that the url is{string} {string}',
    checkURL
);

Then(
    'I expect that the path is{string} {string}',
    checkURLPath
);

Then(
    'I expect the url to{string} contain {string}',
    checkInURLPath
);

Then(
    'I expect that the{string} attribute {string} from element {string} is{string} {string}',
    checkProperty
);

Then(
    'I expect that the font{string} attribute {string} from element {string} is{string} {string}',
    checkFontProperty
);

Then(
    'I expect that checkbox {string} is{string} checked',
    checkSelected
);

Then(
    'I expect that element {string} is{string} selected',
    checkSelected
);

Then(
    'I expect that element {string} is{string} enabled',
    isEnabled
);

Then(
    'I expect that cookie {string}{string} contains {string}',
    checkCookieContent
);

Then(
    'I expect that cookie {string}{string} exists',
    checkCookieExists
);

Then(
    'I expect that element {string} is{string} {int}px {word}',
    checkDimension
);

Then(
    'I expect that element {string} is{string} positioned at {float}px on the {word} axis',
    checkOffset
);

Then(
    'I expect that element {string} {word} the class {string}',
    checkClass
);

Then(
    'I expect a new {word} has{string} been opened',
    checkNewWindow as never
);

Then(
    'I expect the url {string} is opened in a new {word}',
    checkIsOpenedInNewWindow as never
);

Then(
    'I expect that element {string} is{string} focused',
    checkFocus
);

Then(
    'I wait on element {string}( for {int}ms)*( to{string} {word})*',
    {
        wrapperOptions: {
            retry: 3,
        },
    },
    waitFor
);

Then(
    'I expect that a {word} is{string} opened',
    checkModal
);

Then(
    'I expect that a {word}{string} contains the text {string}',
    checkModalText
);
