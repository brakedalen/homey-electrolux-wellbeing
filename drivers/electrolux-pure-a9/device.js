'use strict';

const Homey = require('homey')
const ElectroluxDeltaApi = require('../../electrolux').ElectroluxDeltaApi

let apis = {}

const POLL_INTERVAL = 60000.0
const BACKOFF_POLL_COUNT = 15

class ElectroluxPureDevice extends Homey.Device {

	onInit() {
		this.log('ElectroluxPureDevice has been inited')
		setTimeout(this.onPoll.bind(this), 500)
		setInterval(this.onPoll.bind(this), POLL_INTERVAL)
		let dev = this
		let caps = this.getCapabilities()
		for(let newcap of ['LIGHT_onoff', 'LOCK_onoff']) {
			if(!caps.includes(newcap)) {
				console.log("Migrating device from old version: Adding capability " + newcap)
				this.addCapability(newcap)
			}
		}
		console.log(caps)
		this.registerMultipleCapabilityListener(['onoff', 'FAN_speed', 'SMART_mode', 'IONIZER_onoff', 'LIGHT_onoff', 'LOCK_onoff'], (valueObj, optsObj) => {
			this.log('Setting caps', valueObj);
			return dev.setDeviceOpts.bind(dev)(valueObj)
		}, 500);
	}

	onDeleted() {
		this.isDeleted = true
	}

	async setDeviceOpts(valueObj) {
		const deviceId = this.getData().id
		const client = this.getApi()
		if (valueObj.onoff !== undefined) {
			this.log("onoff: " + valueObj.onoff)
			await client.sendDeviceCommand(deviceId, {
				WorkMode: valueObj.onoff ? (valueObj.SMART_mode == "manual" ? "Manual" : "Auto") : "PowerOff"
			})
		}
		if (valueObj.SMART_mode !== undefined && valueObj.onoff === undefined) {
			this.log("SMART_mode: " + valueObj.SMART_mode)
			await client.sendDeviceCommand(deviceId, {
				WorkMode: valueObj.SMART_mode == "manual" ? "Manual" : "Auto"
			})
		}
		if (valueObj.LIGHT_onoff !== undefined) {
			this.log("LIGHT_onoff: " + valueObj.LIGHT_onoff)
			await client.sendDeviceCommand(deviceId, {
				LedRingLight: valueObj.LIGHT_onoff
			})
		}
		if (valueObj.LOCK_onoff !== undefined) {
			this.log("LOCK_onoff: " + valueObj.LOCK_onoff)
			await client.sendDeviceCommand(deviceId, {
				SafetyLock: valueObj.LOCK_onoff
			})
		}
		if (valueObj.IONIZER_onoff !== undefined) {
			this.log("IONIZER_onoff: " + valueObj.IONIZER_onoff)
			await client.sendDeviceCommand(deviceId, {
				Ionizer: valueObj.IONIZER_onoff
			})
		}
		if (valueObj.FAN_speed !== undefined) {
			let fanSpeed = Math.floor(0.1 * valueObj.FAN_speed - 1)
			if (fanSpeed < 1) fanSpeed = 1
			if (valueObj.FAN_speed <= 0) {
				await client.sendDeviceCommand(deviceId, {
					WorkMode: "PowerOff"
				})
			} else {
				this.log("FAN_speed: " + fanSpeed)
				await client.sendDeviceCommand(deviceId, {
					WorkMode: "Manual",
					Fanspeed: fanSpeed
				})
			}
		}
		setTimeout(this.onPoll.bind(this), 500)
	}

	getApi() {
		const settings = this.getSettings()
		var client = apis[settings.username]
		if (!client) {
			this.log("Creating new API object for account " + settings.username)
			client = apis[settings.username] = new ElectroluxDeltaApi()
			client.setAuth(settings.username, settings.password)
			client.lastPoll = 0
			client.failTime = 0
		}
		return client
	}

	async onPoll() {
		if(this.isDeleted) return
		const deviceId = this.getData().id
		if (!deviceId) return
		this.log("Polling for device " + deviceId)
		const settings = this.getSettings()
		if (!settings.username) {
			this.log("Device is not configured")
			return;
		}
		const client = this.getApi()
		let now = Date.now()
		if ((now - client.failTime) < (POLL_INTERVAL * BACKOFF_POLL_COUNT)) {
			this.log("In failure back-off status")
			return
		}
		try {
			if (now - client.lastPoll > (POLL_INTERVAL * 0.5)) {
				this.log("Will poll account " + settings.username + " for appliance status")
				client.appliances = await client.getAppliances()
			}
			// this.log(await client.appliances)
		} catch (err) {
			this.log("Error: " + err)
			client.failTime = now
			return
		}
		if (client.appliances) {
			let appliance = await client.getAppliance(deviceId);
			console.log(appliance)
			if (!appliance) {
				this.log("Device " + deviceId + " no longer found in account")
				this.setUnavailable("Device no longer in account. Check the mobile app and verfy that you use the correct account.")
			} else if (!appliance.twin) {
				this.log("Device " + deviceId + " missing required data")
				this.setUnavailable("Device has no data. Check for service outages.")
			} else if (appliance.twin.connectionState != "Connected") {
				this.log("Device " + deviceId + " is not connected")
				this.setUnavailable("Device is not connected. Check device power and Wi-Fi connectivity.")
			} else if (!appliance.twin.properties || !appliance.twin.properties.reported) {
				this.log("Device " + deviceId + " missing propertied data")
				this.setUnavailable("Device has no properties data. Check for service outages.")
			} else {
				this.setAvailable()
				this.updateAppliance(appliance)
			}
		}
	}

	updateAppliance(appliance) {
		this.log("Updating appliance " + appliance.twin.deviceId)
		const props = appliance.twin.properties.reported
		console.log(appliance.twin.properties.reported)

		this.setCapabilityValue('measure_co2', props.CO2)
		this.setCapabilityValue('measure_humidity', props.Humidity)
		this.setCapabilityValue('measure_pm25', props.PM2_5)
		this.setCapabilityValue('measure_pm10', props.PM10)
		this.setCapabilityValue('measure_pm1', props.PM1)
		this.setCapabilityValue('measure_voc', props.TVOC)
		this.setCapabilityValue('measure_luminance', props.EnvLightLvl ? props.EnvLightLvl : 0) // Mapping formula?
		this.setCapabilityValue('measure_temperature', props.Temp)
		this.setCapabilityValue('measure_FILTER', props.FilterLife)

		if (props.Workmode == 'Auto') {
			this.setCapabilityValue('onoff', true)
			this.setCapabilityValue('SMART_mode', 'smart')
			this.setCapabilityValue('FAN_speed', 10.0 * (props.Fanspeed + 1))
		} else if (props.Workmode == 'Manual') {
			this.setCapabilityValue('onoff', true)
			this.setCapabilityValue('SMART_mode', 'manual')
			this.setCapabilityValue('FAN_speed', 10.0 * (props.Fanspeed + 1))
		} else /* if(props.Workmode == 'PowerOff')*/ {
			this.setCapabilityValue('onoff', false)
			this.setCapabilityValue('FAN_speed', 0)
		}
		this.setCapabilityValue('IONIZER_onoff', props.Ionizer)
		this.setCapabilityValue('LIGHT_onoff', props.UILight)
		this.setCapabilityValue('LOCK_onoff', props.SafetyLock)
	}

	flow_set_fan_speed(args, state) {
		return this.setDeviceOpts({ FAN_speed: args.fan_speed })
	}

	flow_enable_smart_mode(args, state) {
		return this.setDeviceOpts({ SMART_mode: 'smart' })
	}

	flow_enable_ionizer(args, state) {
		return this.setDeviceOpts({ IONIZER_onoff: true })
	}

	flow_disable_ionizer(args, state) {
		return this.setDeviceOpts({ IONIZER_onoff: false })
	}
}

module.exports = ElectroluxPureDevice;
