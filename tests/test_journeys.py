import copy
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import app


def journey(gid="trip-1", departure="2026-11-05T10:00:00+01:00",
            arrival="2026-11-05T11:00:00+01:00"):
    return {"tripLegs": [{
        "origin": {"stopPoint": {"gid": "stop-a", "name": "Varekil"}, "plannedTime": departure},
        "destination": {"stopPoint": {"gid": "stop-b", "name": "Stenungsön"}, "plannedTime": arrival},
        "serviceJourney": {"gid": gid, "line": {"shortName": "2", "transportMode": "bus"}},
    }]}


def next_link(reference):
    return "https://ext-api.vasttrafik.se/pr/v4/journeys?" + urlencode({
        "originGid": "stop-a", "destinationGid": "stop-b", "paginationReference": reference,
    })


class PaginationTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self.config = patch.object(app, "load_config", return_value={"stop_a": "a", "stop_b": "b"})
        self.stops = patch.object(app, "resolve_stop", side_effect=lambda name: {"gid": name, "name": name})
        self.config.start()
        self.stops.start()
        self.addCleanup(self.config.stop)
        self.addCleanup(self.stops.stop)

    def test_initial_and_next_request_keep_search_time_and_direction(self):
        for direction, origin, destination in (("a-b", "a", "b"), ("b-a", "b", "a")):
            with self.subTest(direction=direction), patch.object(app, "vt_get", side_effect=[
                {"results": [journey()], "links": {"next": next_link("opaque+/=% value")}},
                {"results": [journey("overlap", "2026-11-05T10:30:00+01:00")], "links": {}},
            ]) as get:
                query = {"direction": direction, "dateTime": "2026-11-05T09:00:00+01:00", "limit": 10}
                first = self.client.get("/api/journeys", query_string=query)
                self.assertEqual(first.status_code, 200)
                self.assertEqual(first.json["nextPaginationReference"], "opaque+/=% value")
                query["paginationReference"] = first.json["nextPaginationReference"]
                second = self.client.get("/api/journeys", query_string=query)
                self.assertEqual(second.status_code, 200)
                expected = {"originGid": origin, "destinationGid": destination,
                            "dateTime": query["dateTime"], "limit": 10}
                self.assertEqual(get.call_args_list[0].args, ("/journeys", expected))
                self.assertEqual(get.call_args_list[1].args, ("/journeys", {
                    **expected, "paginationReference": "opaque+/=% value"}))
                self.assertIsNone(second.json["nextPaginationReference"])
                self.assertEqual(second.json["results"][0]["departure"], "2026-11-05T10:30:00+01:00")

    def test_empty_page_can_have_next_reference(self):
        with patch.object(app, "vt_get", return_value={"results": [], "links": {"next": next_link("next")}}):
            result = self.client.get("/api/journeys")
            self.assertEqual(result.json["results"], [])
            self.assertEqual(result.json["nextPaginationReference"], "next")

    def test_nonempty_last_page_has_no_reference(self):
        with patch.object(app, "vt_get", return_value={"results": [journey()], "links": {"next": None}}):
            self.assertIsNone(self.client.get("/api/journeys").json["nextPaginationReference"])

    def test_missing_links_is_end_of_results(self):
        self.assertIsNone(app.next_pagination_reference({}))

    def test_malformed_upstream_links_return_502(self):
        for links in ([], {"next": {}}, {"next": "/journeys?other=x"},
                      {"next": "/journeys?paginationReference="},
                      {"next": "/journeys?paginationReference=a&paginationReference=b"}):
            with self.subTest(links=links), patch.object(app, "vt_get", return_value={"results": [], "links": links}):
                self.assertEqual(self.client.get("/api/journeys").status_code, 502)

    def test_invalid_client_queries_do_not_call_upstream(self):
        for query in ({"direction": "invalid"}, {"limit": "invalid"},
                      {"paginationReference": ""}, {"paginationReference": "next"}):
            with self.subTest(query=query), patch.object(app, "vt_get") as get:
                self.assertEqual(self.client.get("/api/journeys", query_string=query).status_code, 400)
                get.assert_not_called()

    def test_cursor_is_never_used_as_a_request_url(self):
        reference = "https://example.invalid/private"
        with patch.object(app, "vt_get", return_value={"results": []}) as get:
            self.client.get("/api/journeys", query_string={
                "dateTime": "2026-11-05T09:00:00Z", "paginationReference": reference})
            self.assertEqual(get.call_args.args[0], "/journeys")
            self.assertEqual(get.call_args.args[1]["paginationReference"], reference)

    def test_legacy_response_fields_are_preserved(self):
        with patch.object(app, "vt_get", return_value={"results": [journey()]}):
            response = self.client.get("/api/journeys").json
            self.assertTrue({"origin", "destination", "results", "generatedAt"} <= response.keys())
            self.assertTrue({"departure", "arrival", "changes", "lines", "legs"} <= response["results"][0].keys())


class JourneyIdentityTests(unittest.TestCase):
    def test_realtime_update_preserves_key_and_updates_displayed_time(self):
        original = journey()
        updated = copy.deepcopy(original)
        updated["tripLegs"][0]["origin"]["estimatedTime"] = "2026-11-05T10:12:00+01:00"
        updated["tripLegs"][0]["destination"]["estimatedTime"] = "2026-11-05T11:12:00+01:00"
        updated["detailsReference"] = "new-details-reference"
        self.assertEqual(app.journey_key(original), app.journey_key(updated))
        self.assertEqual(app.shape_journey(updated)["departure"], "2026-11-05T10:12:00+01:00")

    def test_same_departure_different_service_is_not_merged(self):
        self.assertNotEqual(app.journey_key(journey("one")), app.journey_key(journey("two")))

    def test_same_initial_leg_different_connection_is_not_merged(self):
        one = journey()
        two = copy.deepcopy(one)
        one["tripLegs"] += journey("connection-one")["tripLegs"]
        two["tripLegs"] += journey("connection-two")["tripLegs"]
        self.assertNotEqual(app.journey_key(one), app.journey_key(two))

    def test_same_service_on_different_dates_is_not_merged(self):
        self.assertNotEqual(app.journey_key(journey()), app.journey_key(journey(
            departure="2026-11-06T10:00:00+01:00", arrival="2026-11-06T11:00:00+01:00")))

    def test_equivalent_offsets_have_same_identity(self):
        self.assertEqual(app.journey_key(journey()), app.journey_key(journey(
            departure="2026-11-05T09:00:00Z", arrival="2026-11-05T10:00:00Z")))

    def test_incomplete_identity_does_not_merge(self):
        self.assertIsNone(app.journey_key({}))
        for missing in ("service", "stop", "time", "offset"):
            value = journey()
            leg = value["tripLegs"][0]
            if missing == "service":
                del leg["serviceJourney"]["gid"]
            elif missing == "stop":
                del leg["origin"]["stopPoint"]["gid"]
            elif missing == "time":
                leg["origin"]["plannedTime"] = None
            else:
                leg["origin"]["plannedTime"] = "2026-11-05T10:00:00"
            with self.subTest(missing=missing):
                self.assertIsNone(app.journey_key(value))

    def test_different_walking_connections_remain_distinct(self):
        one, two = journey(), journey()
        one["connectionLinks"] = [{"distanceInMeters": 100}]
        two["connectionLinks"] = [{"distanceInMeters": 200}]
        self.assertNotEqual(app.journey_key(one), app.journey_key(two))

    def test_midnight_preserves_full_timestamps(self):
        value = journey(departure="2026-11-05T23:40:00+01:00", arrival="2026-11-06T00:20:00+01:00")
        shaped = app.shape_journey(value)
        self.assertEqual(shaped["departure"], "2026-11-05T23:40:00+01:00")
        self.assertEqual(shaped["arrival"], "2026-11-06T00:20:00+01:00")
        self.assertIsNotNone(shaped["key"])


if __name__ == "__main__":
    unittest.main()
