// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';


const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];


describe('The applauncher plugin', function () {
    let testRig;
    let localPlugin, phone;

    // The last packet the phone received with the given body property
    function lastReceived(property) {
        const packets = phone.handlePacket.calls.allArgs()
            .map(([packet]) => packet)
            .filter(packet => packet.type === 'kdeconnect.applauncher' &&
                packet.body.hasOwnProperty(property));

        return packets[packets.length - 1];
    }

    function request(body) {
        phone.sendPacket({type: 'kdeconnect.applauncher.request', body: body});
    }

    beforeAll(async function () {
        testRig = new Utils.TestRig();
        // Only the local side acts as the PC; the remote device plays a phone
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: ['kdeconnect.applauncher'],
                outgoingCapabilities: ['kdeconnect.applauncher.request'],
            },
            remoteDevice: {
                incomingCapabilities: ['kdeconnect.applauncher.request'],
                outgoingCapabilities: ['kdeconnect.applauncher'],
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(phone, 'handlePacket').and.callThrough();
            spyOn(localPlugin, '_launchApp').and.returnValue(true);
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('applauncher');
        phone = testRig.remoteDevice;

        expect(localPlugin).toBeDefined();
        expect(phone._plugins.get('applauncher')).toBeUndefined();

        testRig.setConnected(true);
    });

    it('sends the sorted list of visible applications', async function () {
        request({requestAppList: true});

        await phone.awaitPacket('kdeconnect.applauncher');
        const {appList} = lastReceived('appList').body;
        const visible = localPlugin._getApps();

        expect(appList.length).toBe(visible.size);
        expect(appList.length).toBeGreaterThan(0);

        for (const app of appList) {
            expect(typeof app.id).toBe('string');
            expect(typeof app.name).toBe('string');
            expect(visible.has(app.id)).toBeTrue();
        }

        const names = appList.map(app => app.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it('sends icons as PNGs and skips unknown applications', async function () {
        const ids = [...localPlugin._getApps().keys()].slice(0, 3);
        request({requestIcons: [...ids, 'not-an-app.desktop'], iconSize: 48});

        await phone.awaitPacket('kdeconnect.applauncher', {iconSize: 48});
        const {icons} = lastReceived('icons').body;

        expect(icons['not-an-app.desktop']).toBeUndefined();
        expect(Object.keys(icons).length).toBeGreaterThan(0);

        for (const [id, data] of Object.entries(icons)) {
            expect(ids).toContain(id);
            expect([...GLib.base64_decode(data).slice(0, 8)]).toEqual(PNG_SIGNATURE);
        }
    });

    it('splits many icons over several packets', async function () {
        const ids = [...localPlugin._getApps().keys()];
        const expected = ids.filter(id => localPlugin._renderIcon(
            localPlugin._getApps().get(id), 16) !== null).length;
        request({requestIcons: ids, iconSize: 16});

        let received = 0;

        while (received < expected) {
            await Promise.idle(GLib.PRIORITY_DEFAULT_IDLE);
            received = phone.handlePacket.calls.allArgs()
                .filter(([packet]) => packet.body.iconSize === 16)
                .reduce((sum, [packet]) => sum + Object.keys(packet.body.icons).length, 0);
        }

        const packets = phone.handlePacket.calls.allArgs()
            .filter(([packet]) => packet.body.iconSize === 16);

        expect(received).toBe(expected);
        expect(packets.length).toBe(Math.ceil(expected / 20));
    });

    it('clamps the icon size', async function () {
        const [id] = localPlugin._getApps().keys();
        request({requestIcons: [id], iconSize: 100000});

        await phone.awaitPacket('kdeconnect.applauncher', {iconSize: 256});
    });

    it('launches a listed application', async function () {
        const [id] = localPlugin._getApps().keys();
        request({launch: id});

        await phone.awaitPacket('kdeconnect.applauncher', {launched: id, success: true});

        expect(localPlugin._launchApp).toHaveBeenCalledTimes(1);
        expect(localPlugin._launchApp.calls.argsFor(0)[0].get_id()).toBe(id);
    });

    it('refuses to launch anything else', async function () {
        spyOn(globalThis, 'logError');
        request({launch: '../../usr/bin/rm.desktop'});

        await phone.awaitPacket('kdeconnect.applauncher', {
            launched: '../../usr/bin/rm.desktop',
            success: false,
        });

        expect(localPlugin._launchApp).not.toHaveBeenCalled();
        expect(globalThis.logError).toHaveBeenCalled();
    });

    it('resends the list when applications change', async function () {
        // Skip the settle delay
        spyOn(GLib, 'timeout_add_seconds').and.callFake((priority, delay, func) => {
            func();
            return 0;
        });
        localPlugin._monitor.emit('changed');

        await phone.awaitPacket('kdeconnect.applauncher');
        expect(lastReceived('appList')).toBeDefined();
    });
});
