'use strict';

var mongodb = require('mongodb');
var Promise = require('bluebird');
var pkg = require('../package');
var queue = require('./queue');
var docker = require('./docker');
var MongoClient = mongodb.MongoClient;
var dbHost = process.env.MONGO_HOST || 'localhost';
var dbName = 'inhouse';
var db;

// PROMISIFICATION
// =============================================================================
 Promise.promisifyAll(mongodb);

// MAIN PROCESS
// =============================================================================

/**
* Connect to mongo and start the builder
*/
MongoClient.connectAsync('mongodb://' + dbHost + '/' + dbName)
  .then(function(database) {
    db = database;

    log(pkg.name + ' is running...');

    startBuilder();
  });

/**
* Function handling the constant queue retrival and builds docker images
*
* @param {Object} err - the error object, if exists; log the error, continue
*/
function startBuilder (err) {

  function next (err) {
    if (err) {
      error(err);
    }

    // Using setTimeout to not trigger builds all the time
    // plus not worrying about stack overflow:
    Promise.delay(100)
      .then(startBuilder);
  }

  // Read the next item in the queue
  queue.next(db)
    .then(function (build) {
      if (!build) {
        return next();
      }

      return updateWithStateBuilding(build)
        .then(docker.build)
        .then(updateWithStateSuccess(build))
        .catch(updateWithStateFailed(build))
        .then(rejectUnsuccessful)
        .then(startNewContainer)
        .then(next)
        .catch(next);
    })
    .catch(function(err) {
      error(err);
      error('FATAL. Shutting down...');
      process.exit(1);
      return;
    });
}

// PROMISE SEGMENTS
// =============================================================================

/**
* Sets and updates the build (buildqueue item) with the state of building
*
* @param {Object} build - the buildqueue item that you wish to update
* @returns {Promise(Object)} - the updated build
*/
function updateWithStateBuilding(build) {
  log(build.fullName + ' building...');
  build.state = 'BUILDING';
  return queue.update(db, build);
}

/**
* Sets and updates the build (buildqueue item) with the state of success
*
* @param {Object} build - the buildqueue item that you wish to update
* @returns {Promise(Object)} - the updated build
*/
function updateWithStateSuccess(build) {
  return function(message) {
    build.nrOfAttempts += 1;
    build.buildAt = new Date();
    log(build.fullName + ' succeeded!');
    build.isSuccessful = true;
    build.message = message;
    build.state = 'SUCCESS';
    return queue.update(db, build);
  }
}

/**
* Sets and updates the build (buildqueue item) with the state of failed or retyring
* depending on the number of tries
*
* @param {Object} build - the buildqueue item that you wish to update
* @returns {Promise(Object)} - the updated build
*/
function updateWithStateFailed(build) {
  return function(err) {
    build.nrOfAttempts += 1;
    build.buildAt = new Date();
    error(build.fullName + ' failed!');
    build.message = err.message;
    build.state = build.nrOfAttempts === 5 ? 'FAILURE' : 'RETRYING';
    return queue.update(db, build);
  }
}

/**
* Simple function for rejecting builds with the 'isSuccessful' flag set to false
*
* @param {Object} build - the buildqueue item that you wish to update
* @returns {Promise(Object)} - the updated build
*/
function rejectUnsuccessful(build) {
  return new Promise(function (resolve, reject) {
    return build.isSuccessful ? resolve(build) : reject();
  });
}

/**
* Function for startying a new container given a build context
* Also removes all existing containers matching that build, if successful
*
* @param {Object} build - the buildqueue item that you wish to start a new container from
*/
function startNewContainer(build) {
  return docker.getRunning(build)
    .then(function (oldContainers) {
      return docker.start(build)
        .delay(10 * 1000)
        .then(killOldIfNew(oldContainers))
        .then(function(containerName) {
          return log(build.fullName + '. Container: ' + containerName + ', up and running.');
        })
        .catch(function(containerName) {
          return error(build.fullName + '. Container: ' + containerName + ', didn\'t run for 10 seconds');
        })
    });
}

/**
* Function for killing old containers for a build, if a new is up and running
* Note that it's a double function to be able to use two parameters in a chain
*
* @param {Array} oldContainers - the old containers to remove if running
* @param {String} The container name of the new container
* @return {Promise(String)} - the container name of the new container
*/
function killOldIfNew(oldContainers) {
  return function (containerName) {
    return docker.isRunning(containerName)
      .then(function (isRunning) {
        return new Promise(function (resolve, reject) {
          if (!isRunning) {
            return reject(containerName);
          }

          return docker.kill(oldContainers)
            .then(function (){
              return resolve(containerName);
            });
        });
      });
  }
}

// HELPER FUNCTIONS
// =============================================================================

function error () {
  var args = Array.prototype.slice.call(arguments);
  var now = new Date().toString();
  console.error.apply(console, ['[' + now + ']'].concat(args));
}

function log () {
  var args = Array.prototype.slice.call(arguments);
  var now = new Date().toString();
  console.log.apply(console, ['[' + now + ']'].concat(args));
}
