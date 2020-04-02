'use strict';

/**
 * Regular expression to classify if a valid IPv4 or IPv6 address is local.
 * Note: does not validate that the string is a valid IPv4 or IPv6 address.
 * Note: assumes the local IP address uses the private class A address range.
 */
const LOCAL_IP = /^::1$|^(?:::ffff:)?(?:10|127)\./;

module.exports = {
    LOCAL_IP
};
